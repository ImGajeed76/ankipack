/**
 * Message wording is free to change; these are not, so branch on the code.
 * `invalid-input` is a value the caller passed, `invalid-document` a
 * `collection.data` edit that would not import.
 */
export type AnkipackErrorCode =
  | "deck-not-found"
  | "notetype-not-found"
  | "name-conflict"
  | "id-conflict"
  | "invalid-input"
  | "media-name"
  | "invalid-package"
  | "unsupported-schema"
  | "invalid-document";

/** Every error this library raises. */
export class AnkipackError extends Error {
  readonly code: AnkipackErrorCode;

  constructor(code: AnkipackErrorCode, message: string) {
    super(message);
    this.name = "AnkipackError";
    this.code = code;
  }
}

/** Shorthand, so a throw site reads as one expression. */
export function fail(code: AnkipackErrorCode, message: string): never {
  throw new AnkipackError(code, message);
}
