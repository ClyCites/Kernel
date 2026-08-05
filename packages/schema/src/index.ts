/**
 * @clycites/schema — the ClyCites kernel core-facts schema.
 *
 * This package is the single source of truth for the shape of every record in
 * the kernel. TypeScript types, the OpenAPI contract, and the database types
 * are all generated from here. Nothing redefines a core entity anywhere else.
 *
 * Companion document: ClyCites Kernel — Core Facts Specification v0.2.
 * Section references in the source point at that document.
 */

export const SCHEMA_VERSION = "0.3.0";

export * from "./primitives.js";
export * from "./enums.js";
export * from "./values.js";
export * from "./envelope.js";
export * from "./entities/index.js";
export * from "./inference.js";
