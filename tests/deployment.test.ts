import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { configuration, DEFAULT_DATABASE_URL } from "../apps/api/src/config.ts";

const deploymentDatabaseUrl = "postgresql://database.example.test/tijara";
const deploymentOrigin = "https://tijara.example.test";
const renderOrigin = "https://tijara.onrender.com";
const configurationVariables = [
  "NODE_ENV",
  "DATABASE_URL",
  "DATABASE_SCHEMA",
  "APP_ORIGIN",
  "RENDER_EXTERNAL_URL",
] as const;

function environment(t: TestContext, values: Record<string, string> = {}) {
  const original = new Map(
    configurationVariables.map((name) => [name, process.env[name]]),
  );
  for (const name of configurationVariables) delete process.env[name];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("development keeps its local defaults and ignores Render's external URL", (t) => {
  environment(t, { RENDER_EXTERNAL_URL: renderOrigin });
  assert.deepEqual(configuration(), {
    databaseUrl: DEFAULT_DATABASE_URL,
    schema: "public",
    appOrigin: "http://localhost:3000",
    production: false,
    serveStatic: false,
  });
});

test("production refuses missing or blank deployment database configuration", (t) => {
  environment(t, { NODE_ENV: "production", APP_ORIGIN: deploymentOrigin });
  assert.throws(() => configuration(), /DATABASE_URL.*explicitly configured/);
  for (const databaseUrl of ["", " ", "\t\n"]) {
    process.env.DATABASE_URL = databaseUrl;
    assert.throws(() => configuration(), /DATABASE_URL.*explicitly configured/);
  }
  process.env.DATABASE_URL = deploymentDatabaseUrl;
  assert.throws(
    () => configuration({ databaseUrl: " \t" }),
    /DATABASE_URL.*explicitly configured/,
  );
});

test("production accepts explicit database options and environment bindings", (t) => {
  environment(t, {
    DATABASE_URL: deploymentDatabaseUrl,
    APP_ORIGIN: deploymentOrigin,
  });
  assert.equal(
    configuration({ production: true }).databaseUrl,
    deploymentDatabaseUrl,
  );
  const explicitDatabaseUrl = "postgresql://other.example.test/tijara";
  assert.equal(
    configuration({ production: true, databaseUrl: explicitDatabaseUrl })
      .databaseUrl,
    explicitDatabaseUrl,
  );
  delete process.env.DATABASE_URL;
  assert.equal(
    configuration({ production: true, databaseUrl: explicitDatabaseUrl })
      .databaseUrl,
    explicitDatabaseUrl,
  );
});

test("production requires an origin when neither an explicit nor Render origin exists", (t) => {
  environment(t, {
    NODE_ENV: "production",
    DATABASE_URL: deploymentDatabaseUrl,
  });
  assert.throws(() => configuration(), /APP_ORIGIN.*explicitly configured/);
  process.env.RENDER_EXTERNAL_URL = " \t";
  assert.throws(() => configuration(), /APP_ORIGIN.*explicitly configured/);
});

test("Render's server environment provides a production HTTPS origin", (t) => {
  environment(t, {
    NODE_ENV: "production",
    DATABASE_URL: deploymentDatabaseUrl,
    RENDER_EXTERNAL_URL: `${renderOrigin}/`,
  });
  assert.equal(configuration().appOrigin, renderOrigin);
  assert.equal(configuration().production, true);
  assert.equal(configuration().serveStatic, true);
});

test("explicit custom origins override Render and option origins override APP_ORIGIN", (t) => {
  environment(t, {
    NODE_ENV: "production",
    DATABASE_URL: deploymentDatabaseUrl,
    APP_ORIGIN: `${deploymentOrigin}/`,
    RENDER_EXTERNAL_URL: renderOrigin,
  });
  assert.equal(configuration().appOrigin, deploymentOrigin);
  assert.equal(
    configuration({ appOrigin: "https://another.example.test:8443/" })
      .appOrigin,
    "https://another.example.test:8443",
  );
  for (const appOrigin of ["", " \t"]) {
    assert.throws(
      () => configuration({ appOrigin }),
      /APP_ORIGIN.*explicitly configured/,
    );
    process.env.APP_ORIGIN = appOrigin;
    assert.throws(() => configuration(), /APP_ORIGIN.*explicitly configured/);
  }
});

test("production requires HTTPS for explicit origins and the Render fallback", (t) => {
  environment(t, {
    NODE_ENV: "production",
    DATABASE_URL: deploymentDatabaseUrl,
    RENDER_EXTERNAL_URL: "http://tijara.onrender.com",
  });
  assert.throws(() => configuration(), /HTTPS/);
  process.env.RENDER_EXTERNAL_URL = renderOrigin;
  assert.throws(
    () => configuration({ appOrigin: "http://custom.example.test" }),
    /HTTPS/,
  );
  process.env.APP_ORIGIN = "http://custom.example.test";
  assert.throws(() => configuration(), /HTTPS/);
});

test("all production origin sources reject paths, credentials, queries and invalid URLs", (t) => {
  environment(t, {
    NODE_ENV: "production",
    DATABASE_URL: deploymentDatabaseUrl,
  });
  for (const appOrigin of [
    "not-a-url",
    "/relative",
    "ftp://example.test",
    "https://example.test/path",
    "https://example.test/path/..",
    "https://example.test/%2e%2e/",
    "https://example.test\\path\\..",
    "https://username:password@example.test",
    "https://example.test?query=value",
    "https://example.test?",
    "https://example.test#fragment",
    "https://example.test#",
    "https:example.test",
  ]) {
    assert.throws(() => configuration({ appOrigin }), /HTTP origin/);
    process.env.APP_ORIGIN = appOrigin;
    assert.throws(() => configuration(), /HTTP origin/);
    delete process.env.APP_ORIGIN;
    process.env.RENDER_EXTERNAL_URL = appOrigin;
    assert.throws(() => configuration(), /HTTP origin/);
    delete process.env.RENDER_EXTERNAL_URL;
  }
});
