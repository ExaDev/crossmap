// The package's entry point: starts the module through `#init` (which differs only in how each runtime loads the `.wasm`), hands the binding the error classes it throws, and exports the API and the classes.

import "#init";
import { registerErrorClasses } from "./crossmap.js";
import { CrosswalkStructureError, CrosswalkSyntaxError, RoundTripMismatchError, RuleApplicationError } from "./errors.js";

registerErrorClasses(CrosswalkSyntaxError, CrosswalkStructureError, RuleApplicationError, RoundTripMismatchError);

export { assertRoundTrip, compileCrosswalk, decode, encode, parseCrosswalk, ruleSides, validateCrosswalk } from "./api.js";
export { CrossmapError, CrosswalkStructureError, CrosswalkSyntaxError, RoundTripMismatchError, RuleApplicationError } from "./errors.js";
