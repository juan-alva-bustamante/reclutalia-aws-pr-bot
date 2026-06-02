/**
 * Construye el prompt para que el LLM analice un diff de PR.
 * El prompt está en español y pide respuesta exclusivamente en JSON.
 */
export function buildPRAnalysisPrompt(diff: string, files: string[]): string {
  const fileList = files.length > 0
    ? `Archivos modificados:\n${files.map((f) => `- ${f}`).join("\n")}\n\n`
    : "";

  return `Eres un asistente de revisión de código. Analiza el siguiente diff de un Pull Request y genera un resumen.

${fileList}Diff del PR:
\`\`\`
${diff}
\`\`\`

Responde ÚNICAMENTE con un JSON válido (sin texto antes ni después) con esta estructura exacta:
{
  "summary": "Resumen breve del PR en 2-3 oraciones en español",
  "changes": ["cambio principal 1", "cambio principal 2"],
  "risks": ["riesgo potencial 1"]
}

Reglas:
- El "summary" debe ser conciso y describir QUÉ hace el PR, no listar archivos.
- "changes" debe tener entre 2 y 5 elementos, cada uno describiendo un cambio concreto.
- "risks" debe estar vacío [] si no detectas riesgos reales. Solo incluye riesgos técnicos significativos (seguridad, performance, breaking changes).
- Responde en español.
- NO incluyas texto fuera del JSON.`;
}
