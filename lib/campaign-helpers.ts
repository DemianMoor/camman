import { customAlphabet } from "nanoid";

// Lowercase alphanumeric slug, ambiguous-looking characters removed. Mirrors
// the creative-slug shape so the URL space `/<campaign>/<stage>` reads
// uniformly. 31-char alphabet × 6 positions = ~887M combinations.
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 6;
const slugNanoid = customAlphabet(SLUG_ALPHABET, SLUG_LENGTH);

export function generateCampaignSlug(): string {
  return slugNanoid();
}
