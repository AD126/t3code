import { ServerSettings } from "@t3tools/contracts/settings";
import {
  buildJsonSchemaDocument,
  getJsonSchemaAnyOfBranches,
  getJsonSchemaProperty,
  getNullableJsonSchemaBranch,
  setJsonSchemaDescription,
  writeJsonSchemaArtifacts,
} from "./json-schema";

export const SERVER_SETTINGS_SCHEMA_RELATIVE_PATH = "apps/marketing/public/schemas/settings.json";
export const SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/settings";

export const getVersionedServerSettingsSchemaRelativePath = (version: string) =>
  `${SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.json`;

export function buildServerSettingsJsonSchema(): Record<string, unknown> {
  const schema = buildJsonSchemaDocument(ServerSettings, {
    title: "T3 Code Server Settings",
    description: "JSON Schema for the server-authoritative settings.json file consumed by T3 Code.",
  });

  const properties =
    schema.type === "object" &&
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
      ? schema.properties
      : null;

  if (!properties) {
    throw new Error("ServerSettings JSON schema must expose object properties.");
  }

  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "enableAssistantStreaming")),
    "Whether server-driven assistant responses should stream incrementally to clients when the active provider supports it.",
  );
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "defaultThreadEnvMode")),
    "Default execution environment to use when creating new threads.",
  );
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "textGenerationModelSelection")),
    "Default provider and model to use for server-side text generation features.",
  );
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "providers")),
    "Provider-specific server configuration.",
  );

  const providersBranch = getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "providers"));
  const codexBranch = getNullableJsonSchemaBranch(
    getJsonSchemaProperty(providersBranch ?? {}, "codex"),
  );
  const claudeBranch = getNullableJsonSchemaBranch(
    getJsonSchemaProperty(providersBranch ?? {}, "claudeAgent"),
  );

  setJsonSchemaDescription(codexBranch, "Configuration for the Codex provider.");
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(codexBranch ?? {}, "binaryPath")),
    "Path to the Codex executable. Leave blank to resolve the `codex` executable from PATH.",
  );
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(codexBranch ?? {}, "homePath")),
    "Optional Codex home directory. Leave blank to use the default provider-managed location.",
  );

  setJsonSchemaDescription(claudeBranch, "Configuration for the Claude provider.");
  setJsonSchemaDescription(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(claudeBranch ?? {}, "binaryPath")),
    "Path to the Claude executable. Leave blank to resolve the `claude` executable from PATH.",
  );

  for (const selectionBranch of getJsonSchemaAnyOfBranches(
    getNullableJsonSchemaBranch(getJsonSchemaProperty(schema, "textGenerationModelSelection")),
  )) {
    const providerProperty = getJsonSchemaProperty(selectionBranch, "provider");
    const providerBranch = getNullableJsonSchemaBranch(providerProperty);
    const providerName =
      Array.isArray(providerBranch?.enum) && typeof providerBranch.enum[0] === "string"
        ? providerBranch.enum[0]
        : null;

    if (providerName === "codex") {
      setJsonSchemaDescription(
        getJsonSchemaProperty(selectionBranch, "model"),
        "The Codex model slug to use for text generation.",
      );
    } else if (providerName === "claudeAgent") {
      setJsonSchemaDescription(
        getJsonSchemaProperty(selectionBranch, "model"),
        "The Claude model slug to use for text generation.",
      );
    }
  }

  return {
    ...schema,
    properties: {
      $schema: {
        type: "string",
        description:
          "Optional JSON Schema reference for editor tooling. May point to the stable or versioned T3 Code settings schema URL.",
      },
      ...properties,
    },
  };
}

export function writeServerSettingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  return writeJsonSchemaArtifacts({
    latestRelativePath: SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
    getVersionedRelativePath: getVersionedServerSettingsSchemaRelativePath,
    document: buildServerSettingsJsonSchema(),
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.version === undefined ? {} : { version: options.version }),
  });
}
