import { createInterface } from "node:readline/promises";
import { createDatabase } from "./db.ts";
import { configuration } from "./config.ts";
import { provisionOwner } from "./services/auth.ts";

async function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "OWNER_PASSWORD must be provided securely in noninteractive mode",
    );
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      process.stdin.off("data", read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const read = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b")
          value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", read);
  });
}
try {
  const config = configuration({ production: false });
  const pool = await createDatabase(config.databaseUrl, config.schema);
  try {
    const existing = await pool.query("SELECT 1 FROM users WHERE owner");
    if (existing.rowCount) throw new Error("The platform owner already exists");
    let email = process.env.OWNER_EMAIL,
      name = process.env.OWNER_NAME,
      displayName = process.env.OWNER_DISPLAY_NAME;
    if (!email || !name) {
      if (!process.stdin.isTTY)
        throw new Error("OWNER_EMAIL and OWNER_NAME are required");
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        email ??= await prompt.question("Owner email: ");
        name ??= await prompt.question("Owner name: ");
      } finally {
        prompt.close();
      }
    }
    let password = process.env.OWNER_PASSWORD;
    if (!password) {
      password = await hiddenPassword("Owner password (hidden): ");
      const confirmation = await hiddenPassword("Confirm password (hidden): ");
      if (password !== confirmation) throw new Error("Passwords do not match");
    }
    delete process.env.OWNER_PASSWORD;
    const owner = await provisionOwner(pool, {
      email,
      name,
      displayName: displayName ?? name,
      password,
      phone: process.env.OWNER_PHONE,
    });
    console.log(`Created platform owner #${owner.id}`);
  } finally {
    await pool.end();
  }
} catch (error) {
  const code = (error as { code?: string }).code;
  console.error(
    code === "23505"
      ? "The platform owner or email already exists"
      : error instanceof Error
        ? error.message
        : "Owner creation failed",
  );
  process.exitCode = 1;
}
