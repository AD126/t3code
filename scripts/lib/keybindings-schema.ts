import { KeybindingsConfig } from "@t3tools/contracts";
import {
  buildJsonSchemaDocument,
  getJsonSchemaProperty,
  setJsonSchemaDescription,
  writeJsonSchemaArtifacts,
} from "./json-schema";

export const KEYBINDINGS_SCHEMA_RELATIVE_PATH = "apps/marketing/public/schemas/keybindings.json";
export const KEYBINDINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/keybindings";

export const getVersionedKeybindingsSchemaRelativePath = (version: string) =>
  `${KEYBINDINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.json`;

export function buildKeybindingsJsonSchema(): Record<string, unknown> {
  const schema = buildJsonSchemaDocument(KeybindingsConfig, {
    title: "T3 Code Keybindings",
    description: "JSON Schema for the keybindings.json file consumed by T3 Code.",
  });

  const items =
    schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)
      ? (schema.items as Record<string, unknown>)
      : null;

  setJsonSchemaDescription(items, "Single keybinding rule entry in `keybindings.json`.");
  setJsonSchemaDescription(
    getJsonSchemaProperty(items ?? {}, "key"),
    "Keyboard shortcut to listen for.",
  );
  setJsonSchemaDescription(
    getJsonSchemaProperty(items ?? {}, "command"),
    "Command to execute when the shortcut matches.",
  );
  setJsonSchemaDescription(
    getJsonSchemaProperty(items ?? {}, "when"),
    "Optional expression limiting when the shortcut is active.",
  );

  return schema;
}

export function writeKeybindingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  return writeJsonSchemaArtifacts({
    latestRelativePath: KEYBINDINGS_SCHEMA_RELATIVE_PATH,
    getVersionedRelativePath: getVersionedKeybindingsSchemaRelativePath,
    document: buildKeybindingsJsonSchema(),
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.version === undefined ? {} : { version: options.version }),
  });
}
