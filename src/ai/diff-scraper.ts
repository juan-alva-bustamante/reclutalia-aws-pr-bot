import type { Page } from "playwright";
import { logger } from "../logger.js";
import { navigateAndWait, waitForDomStable, sleep } from "../aws/navigation.js";
import type { DiffResult } from "../types/ai.types.js";

const MAX_DIFF_CHARS = 8000;
const TRUNCATION_NOTE = "\n\n[... diff truncado por exceder el límite de caracteres]";

/**
 * Navega al tab "Changes" del PR en CodeCommit y extrae el diff del DOM.
 * Requiere una página ya autenticada en AWS Console.
 *
 * @param page - Instancia de Playwright Page (autenticada)
 * @param prUrl - URL del PR (normalizada a /details o cualquier vista)
 * @returns DiffResult con el contenido del diff y archivos modificados
 */
export async function scrapeDiff(page: Page, prUrl: string): Promise<DiffResult> {
  // Construir URL del tab "Changes" a partir de la URL del PR
  const changesUrl = buildChangesUrl(prUrl);
  logger.info(`[AI] 📄 Navegando al tab Changes: ${changesUrl}`);

  await navigateAndWait(page, changesUrl, { timeout: 60_000, retries: 2 });
  await sleep(2_000); // Esperar carga adicional del diff
  await waitForDomStable(page);

  // Extraer los nombres de archivos modificados
  const filesChanged = await extractFileNames(page);
  logger.info(`[AI] 📁 Archivos detectados: ${filesChanged.length}`);

  // Extraer el contenido del diff
  const rawDiff = await extractDiffContent(page);

  if (!rawDiff || rawDiff.trim().length === 0) {
    logger.warn("[AI] ⚠️ No se pudo extraer diff del DOM");
    return { content: "", truncated: false, filesChanged };
  }

  // Truncar inteligentemente por archivo si excede el límite
  const { content, truncated } = truncateByFile(rawDiff, filesChanged);

  logger.info(`[AI] ✅ Diff extraído: ${content.length} chars, truncado: ${truncated}`);
  return { content, truncated, filesChanged };
}

/** Construye la URL del tab "Changes" a partir de la URL del PR */
function buildChangesUrl(prUrl: string): string {
  // Reemplazar /details, /activity, /approvals por /changes
  const base = prUrl.replace(/\/(details|activity|approvals|changes)(\?.*)?$/, "");
  const regionMatch = prUrl.match(/[?&]region=([\w-]+)/);
  const region = regionMatch ? regionMatch[1] : "us-east-1";
  return `${base}/changes?region=${region}`;
}

/** Extrae los nombres de archivos modificados del DOM */
async function extractFileNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const files: string[] = [];

    // Estrategia 1: Buscar en el panel de archivos de CodeCommit
    const fileElements = Array.from(document.querySelectorAll(
      '[class*="file-path"], [class*="filename"], [class*="FilePath"], [data-testid*="file"]'
    ));
    for (const el of fileElements) {
      const text = (el.textContent ?? "").trim();
      if (text && (text.includes("/") || text.includes("."))) {
        files.push(text);
      }
    }

    // Estrategia 2: Buscar en headings de secciones de diff
    if (files.length === 0) {
      const headings = Array.from(document.querySelectorAll(
        '[class*="diff-header"] [class*="path"], [class*="DiffHeader"] span'
      ));
      for (const el of headings) {
        const text = (el.textContent ?? "").trim();
        if (text && (text.includes("/") || text.includes("."))) {
          files.push(text);
        }
      }
    }

    // Estrategia 3: Buscar cualquier elemento que parezca un path de archivo
    if (files.length === 0) {
      const allSpans = Array.from(document.querySelectorAll("span, div"));
      for (const el of allSpans) {
        const text = (el.textContent ?? "").trim();
        if (
          text.match(/^[\w\-/.]+\.\w{1,10}$/) &&
          text.includes("/") &&
          text.length < 200
        ) {
          files.push(text);
        }
      }
    }

    // Deduplicar
    return [...new Set(files)];
  });
}

/** Extrae el contenido del diff del DOM */
async function extractDiffContent(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];

    // Estrategia 1: Buscar contenedores de diff con código
    const diffContainers = Array.from(document.querySelectorAll(
      '[class*="diff-viewer"], [class*="DiffViewer"], [class*="code-diff"], [class*="CodeDiff"]'
    ));

    if (diffContainers.length > 0) {
      for (const container of diffContainers) {
        const lines = Array.from(container.querySelectorAll(
          '[class*="diff-line"], [class*="code-line"], tr, [class*="Line"]'
        ));
        for (const line of lines) {
          const text = (line.textContent ?? "").trimEnd();
          if (text) parts.push(text);
        }
      }
    }

    // Estrategia 2: Buscar tablas de diff (formato antiguo)
    if (parts.length === 0) {
      const tables = Array.from(document.querySelectorAll('table[class*="diff"], table[class*="code"]'));
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll("tr"));
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          const codeCell = cells[cells.length - 1];
          if (codeCell) {
            const text = (codeCell.textContent ?? "").trimEnd();
            if (text) parts.push(text);
          }
        }
      }
    }

    // Estrategia 3: Buscar pre/code blocks como fallback
    if (parts.length === 0) {
      const codeBlocks = Array.from(document.querySelectorAll("pre, code"));
      for (const block of codeBlocks) {
        const text = (block.textContent ?? "").trim();
        if (text.length > 50) {
          parts.push(text);
        }
      }
    }

    return parts.join("\n");
  });
}

/**
 * Trunca el diff inteligentemente por archivo.
 * Incluye archivos completos hasta el límite, sin cortar a mitad de un hunk.
 */
function truncateByFile(rawDiff: string, files: string[]): { content: string; truncated: boolean } {
  if (rawDiff.length <= MAX_DIFF_CHARS) {
    return { content: rawDiff, truncated: false };
  }

  // Si no tenemos archivos para dividir, truncar con nota
  if (files.length === 0) {
    const cut = rawDiff.slice(0, MAX_DIFF_CHARS - TRUNCATION_NOTE.length);
    return { content: cut + TRUNCATION_NOTE, truncated: true };
  }

  // Intentar dividir por archivos y tomar los que quepan completos
  let result = "";
  let truncated = false;

  // Dividir el diff por archivo (buscar los nombres como separadores)
  const sections: string[] = [];
  let currentSection = "";

  const lines = rawDiff.split("\n");
  for (const line of lines) {
    const isFileBoundary = files.some((f) => line.includes(f));
    if (isFileBoundary && currentSection.length > 0) {
      sections.push(currentSection);
      currentSection = line + "\n";
    } else {
      currentSection += line + "\n";
    }
  }
  if (currentSection) sections.push(currentSection);

  // Agregar secciones completas hasta el límite
  for (const section of sections) {
    if (result.length + section.length > MAX_DIFF_CHARS - TRUNCATION_NOTE.length) {
      truncated = true;
      break;
    }
    result += section;
  }

  if (truncated) {
    result += TRUNCATION_NOTE;
  }

  // Si no se pudo dividir bien, truncar directamente
  if (result.length === 0) {
    return {
      content: rawDiff.slice(0, MAX_DIFF_CHARS - TRUNCATION_NOTE.length) + TRUNCATION_NOTE,
      truncated: true,
    };
  }

  return { content: result, truncated };
}
