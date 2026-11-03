import { describe, expect, it } from "vitest";
import {
  createOfficialCommandEndpoint,
  OFFICIAL_COMMAND_ROUTES,
  withOfficialCommandEnv,
  type CliOfficialCommandEndpointContract,
} from "../../src/official-command-endpoint/index.js";
import { cliOfficialCommandEndpointModule } from "../../src/official-command-endpoint/module.js";

describe("cli-official-command-endpoint contract", () => {
  it("declares its module manifest", () => {
    expect(cliOfficialCommandEndpointModule.id).toBe("cli-official-command-endpoint");
  });

  it("is implemented by the public entrypoint", () => {
    const contract: CliOfficialCommandEndpointContract = {
      createOfficialCommandEndpoint,
      withOfficialCommandEnv,
    };
    expect(typeof contract.createOfficialCommandEndpoint).toBe("function");
  });

  it("only lends identity to the Sites API", () => {
    expect(OFFICIAL_COMMAND_ROUTES).toEqual([{ prefix: "/api/v1/sites", pluginId: "zcode-site" }]);
  });
});
