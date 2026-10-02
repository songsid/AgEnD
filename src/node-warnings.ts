/**
 * A transitive dependency loads Node's deprecated built-in punycode module.
 * Suppress only that known warning, before the CLI/MCP imports dependencies.
 * Unlike --disable-warning (Node >=20.11), this works across our Node >=20
 * support range and with already-installed service units. Other warnings keep
 * Node's default output/handlers, and explicit --throw-deprecation keeps its
 * exception behavior. Library imports do not install this filter.
 */
const emitWarning = process.emitWarning;
process.emitWarning = function (
  warning: string | Error,
  typeOrOptions?: string | Function | NodeJS.EmitWarningOptions,
  codeOrCtor?: string | Function,
  ctor?: Function,
): void {
  const code = warning instanceof Error
    ? (warning as NodeJS.ErrnoException).code
    : typeof typeOrOptions === "object" && typeOrOptions !== null
      ? typeOrOptions.code
      : typeof codeOrCtor === "string" ? codeOrCtor : undefined;
  const type = warning instanceof Error
    ? warning.name
    : typeof typeOrOptions === "object" && typeOrOptions !== null
      ? typeOrOptions.type
      : typeOrOptions;
  if (code === "DEP0040" && type === "DeprecationWarning" && !process.throwDeprecation) return;
  Reflect.apply(emitWarning, this, [warning, typeOrOptions, codeOrCtor, ctor]);
};
