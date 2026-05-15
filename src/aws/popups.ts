import type { Page } from "playwright";
import { logger } from "../logger.js";
import { sleep } from "./navigation.js";

const FEEDBACK_MODAL_SELECTORS = [
  "div[role='dialog'] button:has-text('Cancel')",
  "[class*='modal-footer'] button:has-text('Cancel')",
  "div[aria-modal='true'] button:has-text('Cancel')",
  "button[aria-label='Close feedback dialog']",
  "div[role='dialog'] button[aria-label='Close']",
];

const SAFE_POPUP_SELECTORS = [
  "#awsccc-cb-btn-accept",
  "button[data-id='awsccc-accept-btn']",
  "button[data-testid='whats-new-close']",
  "[id*='notification'] button[aria-label='Close']",
];

/** Script inyectado para auto-cerrar el modal de Feedback de AWS */
export const AUTO_DISMISS_SCRIPT = `
  const observer = new MutationObserver(() => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.textContent?.trim() === 'Feedback for AWS Sign-in') {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.trim() === 'Cancel' && btn.offsetParent !== null) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) { btn.click(); return; }
          }
        }
        const closeBtn = document.querySelector('[aria-label="Close"], [aria-label="close"]');
        if (closeBtn instanceof HTMLElement) closeBtn.click();
        break;
      }
    }
  });
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
`;

export async function dismissFeedbackModal(page: Page): Promise<void> {
  try {
    const title = page.locator("text='Feedback for AWS Sign-in'");
    if (!(await title.isVisible({ timeout: 1_000 }))) return;

    logger.info("[AWS] Modal Feedback detectado, cerrando...");

    for (const sel of FEEDBACK_MODAL_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 })) {
          await btn.click();
          await sleep(500);
          return;
        }
      } catch {
        /* next selector */
      }
    }
    await page.keyboard.press("Escape");
    await sleep(500);
  } catch {
    /* no modal */
  }
}

export async function dismissCookieModal(page: Page): Promise<void> {
  try {
    const cookieSelectors = [
      "#awsccc-cb-btn-accept",
      "button[data-id='awsccc-cb-btn-accept']",
      "#awsccc-cb-content button:has-text('Accept')",
      "[id*='awsccc'] button:has-text('Accept')",
      "div[class*='cookie'] button:has-text('Accept')",
    ];

    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1_000 })) {
          await btn.click();
          logger.info("[AWS] 🍪 Modal de cookies aceptado");
          await sleep(500);
          return;
        }
      } catch {
        /* next selector */
      }
    }
  } catch {
    /* no cookie modal */
  }
}

export async function dismissPopups(page: Page): Promise<void> {
  await dismissFeedbackModal(page);
  await dismissCookieModal(page);
  for (const sel of SAFE_POPUP_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click();
        await sleep(300);
      }
    } catch {
      /* ignore */
    }
  }
}
