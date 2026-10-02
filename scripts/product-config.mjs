import { readFile } from "node:fs/promises";
import { parseProductConfig } from "../packages/shared/src/product.ts";

export async function loadProductConfig() {
  return parseProductConfig(
    JSON.parse(await readFile(new URL("../config/product.json", import.meta.url), "utf8")),
  );
}

export { productKey } from "../packages/shared/src/product.ts";
