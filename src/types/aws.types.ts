/** Opciones para navegación en AWS Console */
export interface NavigationOptions {
  timeout?: number;
  retries?: number;
}

/** Configuración de un rol de AWS */
export interface RoleConfig {
  url: string;
  name: string;
}

/** Resultado genérico de operación */
export type Result<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };
