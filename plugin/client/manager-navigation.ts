import type { PluginScreenParams } from "@getpaseo/plugin/client";

export const MANAGER_SCREEN_ID = "manager";
export const MANAGER_SECTIONS = [
  { id: "overview", label: "Visão geral" },
  { id: "profiles", label: "Perfis" },
  { id: "pool", label: "Pool de Peers" },
  { id: "jev", label: "Roteamento / Jev" },
  { id: "supervision", label: "Supervisão" },
  { id: "language", label: "Idioma" },
  { id: "maintenance", label: "Manutenção" },
] as const;
export type ManagerSectionId = (typeof MANAGER_SECTIONS)[number]["id"];

export function managerSection(params: PluginScreenParams): ManagerSectionId {
  return MANAGER_SECTIONS.find(section => section.id === params.section)?.id ?? "overview";
}

/** Only closed section identifiers enter the host URL. */
export const managerLocation = (section: ManagerSectionId = "overview") => ({
  screenId: MANAGER_SCREEN_ID, params: { section },
});
export const managerTitle = (params: PluginScreenParams): string =>
  `Equipes · ${MANAGER_SECTIONS.find(section => section.id === managerSection(params))!.label}`;
