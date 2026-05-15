/** Información extraída de una URL de PR de CodeCommit */
export interface PrInfo {
  repo: string;
  prNumber: string;
  url: string;
}

/** Información del autor para el merge en AWS */
export interface AuthorInfo {
  name: string;
  email: string;
}

/** Resultado del flujo completo de PR */
export interface PrFlowResult {
  success: boolean;
  steps: string[];
  error?: string;
}
