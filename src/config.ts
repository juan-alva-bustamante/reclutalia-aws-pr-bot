import "dotenv/config";
import type { RoleConfig } from "./types/aws.types.js";

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
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
  userProfiles: {
    gabrielbarba28: { name: "Gabriel Barba", email: "gabriel.barba@elektra.com.mx" },
    jclievano: { name: "Juan Carlos Lievano", email: "juan.lievano@tecnologiaaccionable.mx" },
    el_chambas3000: { name: "Felipe Guadarrama", email: "felipe.guadarramah@elektra.com.mx" },
    juanalva997: { name: "Juan Alva Bustamante", email: "juan.alva@elektra.com.mx" },
  } as Record<string, { name: string; email: string }>,
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
      url: process.env.ROLE_AUTHORIZER_URL ??
        "https://signin.aws.amazon.com/switchrole?roleName=devops/Authorizer&account=upax-reclutalia-dev",
      name: "devops/Authorizer",
    } satisfies RoleConfig,
    manager: {
      url: process.env.ROLE_MANAGER_URL ??
        "https://signin.aws.amazon.com/switchrole?roleName=devops/Manager&account=upax-reclutalia-dev",
      name: "devops/Manager",
    } satisfies RoleConfig,
    merge: {
      url: process.env.ROLE_MERGE_URL ??
        "https://signin.aws.amazon.com/switchrole?roleName=MergeMaster&account=upax-reclutalia-dev",
      name: "MergeMaster",
    } satisfies RoleConfig,
  },
  sessionFile: "aws_session.json",
  headless: process.env.HEADLESS === "true",
} as const;
