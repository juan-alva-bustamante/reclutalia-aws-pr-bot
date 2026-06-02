import "dotenv/config";
import type { RoleConfig } from "./types/aws.types.js";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

/**
 * Parsea USER_PROFILES del .env.
 * Formato: "username1:Nombre Completo:email@dom.com,username2:Nombre:email@dom.com"
 */
function parseUserProfiles(raw: string): Record<string, { name: string; email: string }> {
  const profiles: Record<string, { name: string; email: string }> = {};
  if (!raw.trim()) return profiles;
  for (const entry of raw.split(",")) {
    const [username, name, email] = entry.trim().split(":");
    if (username && name && email) {
      profiles[username.toLowerCase()] = { name, email };
    }
  }
  return profiles;
}

export const config = {
  telegram: {
    token: required("TELEGRAM_BOT_TOKEN"),
    chatId: required("TELEGRAM_CHAT_ID"),
    ownerUserId: Number(required("TELEGRAM_OWNER_USER_ID")),
    topicId: process.env.TELEGRAM_TOPIC_ID
      ? Number(process.env.TELEGRAM_TOPIC_ID)
      : undefined,
    authorizedUsers: (process.env.TELEGRAM_AUTHORIZED_USERS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0),
  },
  /** Mapeo de username de Telegram → datos de autor para el merge en AWS */
  userProfiles: parseUserProfiles(process.env.USER_PROFILES ?? ""),
  aws: {
    loginUrl: required("AWS_LOGIN_URL"),
    accountId: process.env.AWS_ACCOUNT_ID ?? "",
    username: required("AWS_USERNAME"),
    password: required("AWS_PASSWORD"),
    authorName: process.env.AWS_AUTHOR_NAME ?? "Bot Merge",
    authorEmail: process.env.AWS_AUTHOR_EMAIL ?? "bot@merge.local",
  },
  roles: {
    authorizer: {
      url: required("ROLE_AUTHORIZER_URL"),
      name: process.env.ROLE_AUTHORIZER_NAME ?? "devops/Authorizer",
    } satisfies RoleConfig,
    manager: {
      url: required("ROLE_MANAGER_URL"),
      name: process.env.ROLE_MANAGER_NAME ?? "devops/Manager",
    } satisfies RoleConfig,
    merge: {
      url: required("ROLE_MERGE_URL"),
      name: process.env.ROLE_MERGE_NAME ?? "MergeMaster",
    } satisfies RoleConfig,
  },
  sessionFile: "aws_session.json",
  headless: process.env.HEADLESS === "true",
} as const;
