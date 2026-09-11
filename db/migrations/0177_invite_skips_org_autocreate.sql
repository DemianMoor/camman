-- An INVITED user must not be handed an organization of their own.
--
-- THE BUG THIS FIXES
-- ------------------
-- `handle_new_user()` (0001) fires on EVERY auth.users INSERT and creates a
-- fresh organization with the new user as its `owner`. That was correct when
-- self-signup was the only way in. It is wrong now that Owners invite people
-- (0175): Supabase creates the auth.users row during its OWN /auth/v1/callback,
-- BEFORE it redirects to app/auth/callback/route.ts — so by the time
-- resolveAllowlist() runs, the trigger has already written an org_members row.
--
-- resolveAllowlist() checks org_members BEFORE invites and returns on the first
-- hit (lib/auth/workspace-gate.ts), so it reports `status: 'member'` for that
-- brand-new stray org and NEVER reaches the invite branch. The invitee signs in
-- successfully, lands in an empty organization as its owner, sees zero
-- contacts and zero campaigns, and their invite stays pending forever.
--
-- Observed in the camman-v2 project as a stray "operator-test's Organization"
-- holding 0 contacts, sitting next to the real one.
--
-- THE FIX
-- -------
-- Return early when an open, unexpired invite exists for the new address. The
-- app-side callback then finds no membership, takes the invite branch, and
-- provisions the membership against the INVITING org in the same transaction
-- that burns the invite.
--
-- Self-signup is untouched: with no matching invite the function behaves
-- exactly as before. NULL email (phone-only identities) also falls through to
-- the original path, since `lower(NULL) = lower(NULL)` is NULL, not true.
--
-- Emails are compared case-insensitively even though inviteUserSchema already
-- lowercases on the way in (lib/validators/users.ts) — this function is the
-- last line of defence and must not depend on a caller's normalisation.
--
-- Idempotent: CREATE OR REPLACE on an existing function. The trigger binding
-- itself is unchanged, so no DROP/CREATE TRIGGER and no window where signups
-- create nothing.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id uuid;
  user_display_name text;
BEGIN
  -- Invited users join the inviting org via app/auth/callback/route.ts.
  -- Creating an org here would pre-empt that and strand them in an empty one.
  IF EXISTS (
    SELECT 1
    FROM public.invites i
    WHERE lower(i.email) = lower(NEW.email)
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RETURN NEW;
  END IF;

  user_display_name := COALESCE(
    NEW.raw_user_meta_data->>'display_name',
    split_part(NEW.email, '@', 1)
  );

  INSERT INTO public.organizations (name)
  VALUES (user_display_name || '''s Organization')
  RETURNING id INTO new_org_id;

  INSERT INTO public.org_members (user_id, org_id, role)
  VALUES (NEW.id, new_org_id, 'owner');

  RETURN NEW;
END;
$$;
