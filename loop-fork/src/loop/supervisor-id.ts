/**
 * RA2: the one supervisor id validator and its file name and URL slug
 * encoding. Every module that accepts a supervisor id on the wire, in config,
 * in a manifest or on a command line imports it from here; none keeps its own
 * pattern.
 *
 * A supervisor id is one of:
 * - flat (every id before RA1): `supervisor:<body>`, body
 *   `[a-z0-9][a-z0-9._-]{0,127}`;
 * - role (RA1): `supervisor:<owner>/<name>/<project>`, exactly three
 *   '/'-separated segments of the same characters, each starting with a letter
 *   or digit (so no segment is empty, "." or ".."), body at most 128
 *   characters.
 *
 * Slug (a single path segment, used for URL route segments and directory
 * names): the body with every '/' written as '~'. '~' is never a body
 * character, so a flat id's slug is its body exactly (byte-identical to every
 * name derived before RA2), a role id's slug always holds '~', and the map is
 * injective: no two ids share a slug. '~' is RFC 3986 unreserved, so URLs
 * carry it unescaped, and it is an ordinary file name character.
 *
 * Mailbox file name: `supervisor_<slug>.jsonl`. For a flat id this is the
 * historical `id.replace(/[^a-z0-9._-]/g, "_")` name byte for byte, so live
 * mailboxes keep their files. The historical rule mapped '/' to '_' as well,
 * which would have sent `supervisor:a/b/c` and `supervisor:a_b/c` (or the flat
 * `supervisor:a_b_c`) to one file; this encoding cannot.
 *
 * This module is a leaf (no imports): Temporal workflow code uses it.
 */

export const SUPERVISOR_PREFIX = "supervisor:";
/** The body's length bound, shared by flat and role ids. */
export const SUPERVISOR_ID_BODY_MAX = 128;
/** How a role id's '/' is written in a slug or a mailbox file name. */
export const SUPERVISOR_SLUG_SEPARATOR = "~";

const SEGMENT = "[a-z0-9][a-z0-9._-]";
const FLAT_BODY = `${SEGMENT}{0,127}`;
const ROLE_BODY = `(?=[a-z0-9._/-]{1,${SUPERVISOR_ID_BODY_MAX}}$)${SEGMENT}*/${SEGMENT}*/${SEGMENT}*`;

/** One path segment (owner, name or project): a flat body without '/'. */
export const SUPERVISOR_ID_SEGMENT_RE = new RegExp(`^${FLAT_BODY}$`);
/** A flat (pre-RA1) supervisor id. */
export const FLAT_SUPERVISOR_ID_RE = new RegExp(`^supervisor:${FLAT_BODY}$`);
/** A role id `supervisor:<owner>/<name>/<project>`. */
export const SUPERVISOR_ROLE_ID_RE = new RegExp(`^supervisor:${ROLE_BODY}$`);
/** Any supervisor id: flat or role. The wire, config and manifests use this. */
export const SUPERVISOR_ID_RE = new RegExp(
  `^supervisor:(?:${FLAT_BODY}|${ROLE_BODY})$`
);

const MAILBOX_PREFIX = "supervisor_";
const MAILBOX_SUFFIX = ".jsonl";

export class SupervisorIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupervisorIdError";
  }
}

export const isSupervisorId = (value: unknown): value is string =>
  typeof value === "string" && SUPERVISOR_ID_RE.test(value);

export const isFlatSupervisorId = (value: unknown): value is string =>
  typeof value === "string" && FLAT_SUPERVISOR_ID_RE.test(value);

export const isSupervisorRoleId = (value: unknown): value is string =>
  typeof value === "string" && SUPERVISOR_ROLE_ID_RE.test(value);

/**
 * A repo key "<owner>/<name>": two segments, no ".git" suffix, within the
 * body bound (a role id's first two segments).
 */
export const isSupervisorRepoKey = (value: unknown): value is string => {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split("/");
  return (
    parts.length === 2 &&
    parts.every((part) => SUPERVISOR_ID_SEGMENT_RE.test(part)) &&
    !value.endsWith(".git") &&
    value.length <= SUPERVISOR_ID_BODY_MAX
  );
};

/** The id, or a SupervisorIdError naming `field`. */
export const requireSupervisorId = (
  value: unknown,
  field = "supervisor id"
): string => {
  if (!isSupervisorId(value)) {
    throw new SupervisorIdError(`${field} is invalid`);
  }
  return value;
};

/** The id's single-segment slug: the body, '/' written as '~'. */
export const supervisorSlug = (supervisorId: string): string =>
  requireSupervisorId(supervisorId)
    .slice(SUPERVISOR_PREFIX.length)
    .replaceAll("/", SUPERVISOR_SLUG_SEPARATOR);

/**
 * The id a slug names, or undefined. Only the canonical slug of a valid id
 * decodes: a slug with '~' must decode to a role id, one without to a flat
 * id, so every id has exactly one slug.
 */
export const supervisorIdFromSlug = (slug: string): string | undefined => {
  if (typeof slug !== "string") {
    return undefined;
  }
  if (slug.includes(SUPERVISOR_SLUG_SEPARATOR)) {
    const candidate = `${SUPERVISOR_PREFIX}${slug.replaceAll(SUPERVISOR_SLUG_SEPARATOR, "/")}`;
    return isSupervisorRoleId(candidate) ? candidate : undefined;
  }
  const candidate = `${SUPERVISOR_PREFIX}${slug}`;
  return isFlatSupervisorId(candidate) ? candidate : undefined;
};

/** `supervisor_<slug>.jsonl`: unchanged for every flat id. */
export const supervisorMailboxFileName = (supervisorId: string): string =>
  `${MAILBOX_PREFIX}${supervisorSlug(supervisorId)}${MAILBOX_SUFFIX}`;

/** The id a mailbox file name names, or undefined for any other name. */
export const supervisorIdFromMailboxFileName = (
  fileName: string
): string | undefined => {
  if (
    !(fileName.startsWith(MAILBOX_PREFIX) && fileName.endsWith(MAILBOX_SUFFIX))
  ) {
    return undefined;
  }
  const slug = fileName.slice(
    MAILBOX_PREFIX.length,
    fileName.length - MAILBOX_SUFFIX.length
  );
  return supervisorIdFromSlug(slug);
};
