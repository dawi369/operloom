import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ForkIdentity = {
  schemaVersion: 1;
  id: string;
  displayName: string;
  webTitle: string;
  description: string;
  webOrigin: string;
  mobile: {
    displayName: string;
    slug: string;
    scheme: string;
    bundleIdentifier: string;
  };
};

type ForkOptions = {
  root: string;
  mode: "init" | "check";
  values?: Partial<Pick<ForkIdentity, "id" | "displayName" | "description" | "webOrigin">> & {
    mobileBundle?: string;
  };
};

const productPath = "config/product.json";
const mobilePath = "apps/mobile/app.json";

const readJson = <T>(root: string, path: string) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8")) as T;
const writeJson = (root: string, path: string, value: unknown) =>
  writeFileSync(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);

const normalizedId = (value: string) => value.trim().toLowerCase();
const defaultScheme = (id: string) => id.replace(/[^a-z0-9]/gu, "");

export const validateForkIdentity = (identity: ForkIdentity) => {
  if (identity.schemaVersion !== 1) throw new Error("Unsupported product identity schema.");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(identity.id)) {
    throw new Error("Product id must be a lowercase DNS-style slug.");
  }
  if (!identity.displayName.trim() || !identity.mobile.displayName.trim()) {
    throw new Error("Product display names cannot be empty.");
  }
  const origin = new URL(identity.webOrigin);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost") {
    throw new Error("Web origin must use HTTPS outside localhost.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Web origin must not include a path, query, or fragment.");
  }
  if (!/^[a-z][a-z0-9+.-]*$/u.test(identity.mobile.scheme)) {
    throw new Error("Mobile scheme must be a valid lowercase URI scheme.");
  }
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+){2,}$/u.test(identity.mobile.bundleIdentifier)) {
    throw new Error("Mobile bundle identifier must use reverse-DNS notation.");
  }
};

export const expectedMobileConfig = (identity: ForkIdentity, current: Record<string, any>) => {
  const host = new URL(identity.webOrigin).host;
  const expo = current.expo ?? {};
  return {
    ...current,
    expo: {
      ...expo,
      name: identity.mobile.displayName,
      slug: identity.mobile.slug,
      scheme: identity.mobile.scheme,
      ios: {
        ...expo.ios,
        bundleIdentifier: identity.mobile.bundleIdentifier,
        associatedDomains: [`applinks:${host}`],
      },
      android: {
        ...expo.android,
        package: identity.mobile.bundleIdentifier,
        intentFilters: (expo.android?.intentFilters ?? []).map((filter: Record<string, any>) => ({
          ...filter,
          data: (filter.data ?? []).map((data: Record<string, any>) => ({ ...data, host })),
        })),
      },
    },
  };
};

const differences = (actual: unknown, expected: unknown, prefix = ""): string[] => {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [prefix];
    return expected.flatMap((value, index) =>
      differences(actual[index], value, `${prefix}[${index}]`),
    );
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [prefix];
    return Object.entries(expected).flatMap(([key, value]) =>
      differences(
        (actual as Record<string, unknown>)[key],
        value,
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return Object.is(actual, expected) ? [] : [prefix];
};

export const configureForkIdentity = ({ root, mode, values }: ForkOptions) => {
  const existing = readJson<ForkIdentity>(root, productPath);
  const id = values?.id ? normalizedId(values.id) : existing.id;
  const identity: ForkIdentity = {
    ...existing,
    id,
    displayName: values?.displayName?.trim() || existing.displayName,
    webTitle: values?.displayName?.trim() || existing.webTitle,
    description: values?.description?.trim() || existing.description,
    webOrigin: values?.webOrigin?.trim().replace(/\/$/u, "") || existing.webOrigin,
    mobile: {
      ...existing.mobile,
      displayName: values?.displayName?.trim() || existing.mobile.displayName,
      slug: id,
      scheme: defaultScheme(id),
      bundleIdentifier: values?.mobileBundle?.trim() || existing.mobile.bundleIdentifier,
    },
  };
  validateForkIdentity(identity);

  const hasMobile = existsSync(resolve(root, mobilePath));
  const mobile = hasMobile ? readJson<Record<string, any>>(root, mobilePath) : {};
  const expectedMobile = expectedMobileConfig(identity, mobile);
  const packageJson = readJson<Record<string, any>>(root, "package.json");
  const expectedPackage = { ...packageJson, name: identity.id, description: identity.description };

  if (mode === "check") {
    const errors = [
      ...differences(existing, identity).map((path) => `${productPath}:${path}`),
      ...(hasMobile
        ? differences(mobile, expectedMobile).map((path) => `${mobilePath}:${path}`)
        : []),
      ...differences(packageJson, expectedPackage).map((path) => `package.json:${path}`),
    ];
    if (errors.length) throw new Error(`Fork identity drift:\n${errors.join("\n")}`);
    return identity;
  }

  writeJson(root, productPath, identity);
  if (hasMobile) writeJson(root, mobilePath, expectedMobile);
  writeJson(root, "package.json", expectedPackage);
  return identity;
};

const argumentValue = (name: string) => {
  const exact = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (exact) return exact.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const main = () => {
  const mode = process.argv[2] === "--check" || process.argv[2] === "check" ? "check" : "init";
  const identity = configureForkIdentity({
    root: process.cwd(),
    mode,
    values:
      mode === "init"
        ? {
            id: argumentValue("id"),
            displayName: argumentValue("name"),
            description: argumentValue("description"),
            webOrigin: argumentValue("origin"),
            mobileBundle: argumentValue("mobile-bundle"),
          }
        : undefined,
  });
  console.log(
    mode === "check"
      ? `Fork identity ${identity.id} is consistent.`
      : `Configured ${identity.displayName}. Next: configure provider-owned project ids and run pnpm workbench init.`,
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
