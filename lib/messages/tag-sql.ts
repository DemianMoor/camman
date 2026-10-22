// SQL twins of the tag normalizers in ./tags.ts (spec §A, P4 Task 2). They let
// the audience preview, preflight and the eligibility layers count "would be
// skipped" contacts in SQL with the SAME rules the per-recipient render applies
// in TypeScript. Every list here (junk values, transliteration, states, the
// whitespace class) is GENERATED from the registry and bound as a parameter —
// nothing is hand-typed, so the two sides cannot drift without
// scripts/test-tag-sql-parity.ts going red.
//
// Arrays travel as one delimited string + string_to_array: a JS array
// interpolated into a Drizzle sql template flattens into positional params.
import { sql, type SQL } from "drizzle-orm";

import { FIRST_NAME_MIN, JUNK_VALUES, TAGS, TRANSLIT, US_STATES, type TagKey } from "./tags";

// Exactly JS's \s / String.prototype.trim set. Postgres's \s follows the locale
// and differs on characters like NBSP, so the class is spelled out.
const WS =
  "[\t\n\u000b\f\r    -     　﻿]";

const SINGLE = [...TRANSLIT].filter(([k, v]) => [...k].length === 1 && [...v].length === 1);
const MULTI = [...TRANSLIT].filter(([k, v]) => !([...k].length === 1 && [...v].length === 1));
const TR_FROM = SINGLE.map(([k]) => k).join("");
const TR_TO = SINGLE.map(([, v]) => v).join("");

const SEP = "|";
const JUNK = JUNK_VALUES.join(SEP);
const STATE_CODES = [...US_STATES.keys()].join(SEP);
const STATE_NAMES = [...US_STATES.values()].map((n) => n.toLowerCase()).join(SEP);
const anyOf = (list: string) => sql`ANY(string_to_array(${list}::text, ${SEP}::text))`;

const col = (caAlias: string, c: "first_name" | "zip" | "state") => sql.raw(`${caAlias}.${c}`);
const trimmedSql = (v: SQL) =>
  sql`regexp_replace(coalesce(${v}, ''), ${`^${WS}+|${WS}+$`}::text, '', 'g')`;

function mappedFirstName(t: SQL): SQL {
  return MULTI.reduce<SQL>((acc, [k, v]) => sql`replace(${acc}, ${k}::text, ${v}::text)`, sql`translate(${t}, ${TR_FROM}::text, ${TR_TO}::text)`);
}

function cleanedFirstName(caAlias: string): SQL {
  const mapped = mappedFirstName(trimmedSql(col(caAlias, "first_name")));
  return sql`btrim(regexp_replace(regexp_replace(regexp_replace(${mapped},
    ${`${WS}+`}::text, ' ', 'g'), '[^A-Za-z'' -]', '', 'g'), ' +', ' ', 'g'), ' ')`;
}

/** char_length of the cleaned first name (meaningful only when it is not missing). */
export function firstNameCleanLengthSql(caAlias: string): SQL {
  return sql`char_length(${cleanedFirstName(caAlias)})`;
}

/** TRUE when the contact's value for `key` is MISSING — the twin of `TAGS[key].normalize(v) === null`. */
export function tagMissingSql(key: Exclude<TagKey, "brand">, caAlias: string): SQL {
  if (key === "zip") {
    return sql`(${trimmedSql(col(caAlias, "zip"))} !~ '^[0-9]{5}(-?[0-9]{4})?$')`;
  }
  if (key === "state") {
    const t = trimmedSql(col(caAlias, "state"));
    return sql`NOT (CASE WHEN ${t} ~ '^[A-Za-z]{2}$'
      THEN upper(${t}) = ${anyOf(STATE_CODES)}
      ELSE lower(regexp_replace(${t}, ${`${WS}+`}::text, ' ', 'g')) = ${anyOf(STATE_NAMES)} END)`;
  }
  const t = trimmedSql(col(caAlias, "first_name"));
  const cleaned = cleanedFirstName(caAlias);
  return sql`(${t} = ''
    OR lower(${t}) = ${anyOf(JUNK)}
    OR ${t} ~ '[0-9]'
    OR regexp_replace(${mappedFirstName(t)}, '[A-Za-z]', '', 'g') ~ '[[:alpha:]]'
    OR char_length(regexp_replace(${cleaned}, '[^A-Za-z]', '', 'g')) < ${FIRST_NAME_MIN}::int
    OR char_length(${cleaned}) > ${TAGS.first_name.maxLength}::int)`;
}
