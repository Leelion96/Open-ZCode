import {
  assert,
  test,
  mkdir,
  readFile,
  writeFile,
  join,
  fixtures,
  moduleFrom,
} from "./helpers/product-test.mjs";

test("v2 data relocation copies only the product and keeps bootstrap settings at home", async () => {
  const paths = await moduleFrom("packages/services/src/paths.ts", "copy-paths");
  const oldBase = join(fixtures, "old-base");
  const newBase = join(fixtures, "new-base");
  await mkdir(join(oldBase, ".open-zcode/v2"), { recursive: true });
  await mkdir(join(oldBase, ".zcode/v2"), { recursive: true });
  await writeFile(join(oldBase, ".open-zcode/v2/credentials.json"), "product-copy");
  await writeFile(join(oldBase, ".open-zcode/v2/setting.json"), "bootstrap");
  await writeFile(join(oldBase, ".zcode/v2/credentials.json"), "official-sentinel");
  await paths.copyDataDirectory(oldBase, newBase);
  assert.equal(
    await readFile(join(newBase, ".open-zcode/v2/credentials.json"), "utf8"),
    "product-copy",
  );
  await assert.rejects(readFile(join(newBase, ".open-zcode/v2/setting.json")), { code: "ENOENT" });
  assert.equal(
    await readFile(join(oldBase, ".zcode/v2/credentials.json"), "utf8"),
    "official-sentinel",
  );
  const credentials = await moduleFrom(
    "apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts",
    "credentials",
  );
  assert.equal(
    credentials.resolveSharedZCodeCredentialsPath({ baseDir: oldBase }),
    join(oldBase, ".open-zcode/v2/credentials.json"),
  );
});
