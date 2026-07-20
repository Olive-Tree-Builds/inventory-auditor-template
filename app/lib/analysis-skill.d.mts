export type AnalysisVariable = {
  id: string;
  name: string;
};

export type AnalysisSkillParseResult = {
  variables: AnalysisVariable[];
  errors: string[];
  policyVersion: string | null;
  activeVariableRevision: string | null;
};

export const ACTIVE_VARIABLES_START: string;
export const ACTIVE_VARIABLES_END: string;

export function parseAnalysisSkill(markdown: string): AnalysisSkillParseResult;
export function addAnalysisVariable(markdown: string, requestedName: string): { markdown: string; error: string | null };
export function removeAnalysisVariable(markdown: string, variableId: string): { markdown: string; error: string | null };
export function prepareAnalysisSkillActivation(
  draftMarkdown: string,
  activeMarkdown: string,
  today?: string,
): { markdown: string; error: string | null };
