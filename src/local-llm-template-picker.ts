// Automatic --task template selection for the local-LLM queue (card 48aacf56, item 4).
//
// THE PROBLEM THIS SOLVES. 78 named templates ship under store/local-llm-skills/, and they produce
// markedly better, more consistent output than a free-form chat prompt. But the CALLER had to know
// the right name and pass --task explicitly, so measured over 740 calls almost none were used: 518
// were generic chat and 138 were card-decompose. The templates were effectively dead weight.
//
// This module maps a task description onto the best template, so the caller does not have to
// remember 78 names. It is pure -- no filesystem, no network -- and returns a NAME, never a path.
//
// DELIBERATELY CONSERVATIVE. Returning null (free-form chat) is a perfectly good outcome and the
// documented default: the templates are an OPTIONAL accelerator, not a gate (Peti's clarification
// on card defcc189). A wrong template is worse than no template -- it reshapes the request into
// something the caller did not ask for -- so a match must be specific, and anything vague falls
// through to null rather than guessing.
//
// SECURITY: the returned name is always one of KNOWN_TEMPLATES, a fixed literal set. It can never
// be caller-controlled text, so this cannot become a path-traversal vector on the way to
// store/local-llm-skills/<name>.txt. The API layer re-validates with isValidCategoryName anyway --
// two independent checks, because this one is about correctness and that one is about safety.

/** Templates this picker is willing to choose. A subset of the 78 on disk: only the ones with a
 *  recognisable, unambiguous trigger shape. The rest stay available for an explicit --task. */
export const KNOWN_TEMPLATES = [
  'regex',
  'type-def',
  'test-scaffold',
  'test-suite-full',
  'docstring',
  'commit-msg',
  'translate',
  'keywords',
  'summarize',
  'sql-migration',
  'json-transform',
  'card-decompose',
  'msg-triage',
  'user-story',
  'error-i18n',
  'yaml-config',
  'shell-script',
  'code-explain',
  'edge-cases',
  'release-notes',
] as const

export type TemplateName = (typeof KNOWN_TEMPLATES)[number]

/**
 * Rules are ordered: the FIRST match wins, so put the most specific shapes first.
 *
 * Each rule needs a distinctive trigger. Bare words like "code" or "test" appear in almost every
 * description and would mis-route constantly, so triggers are phrases or strong nouns.
 */
interface Rule {
  readonly template: TemplateName
  readonly patterns: readonly RegExp[]
}

const RULES: readonly Rule[] = [
  // Very specific artefact shapes first -- these read unambiguously.
  { template: 'regex', patterns: [/\bregexp?\b/i, /\bregular expression\b/i, /\bregulari[sz] kifejez/i] },
  { template: 'sql-migration', patterns: [/\bmigration\b.*\bsql\b/i, /\bsql\b.*\bmigration\b/i, /\balter table\b/i, /\bmigraci[oó]\b.*\bsql\b/i] },
  { template: 'commit-msg', patterns: [/\bcommit (message|msg)\b/i, /\bcommit-?[uü]zenet\b/i] },
  { template: 'release-notes', patterns: [/\brelease notes?\b/i, /\bchangelog entry\b/i, /\bkiad[aá]si jegyzet/i] },
  { template: 'docstring', patterns: [/\bdocstring\b/i, /\bjsdoc\b/i, /\bdoc comment\b/i] },
  { template: 'yaml-config', patterns: [/\byaml\b/i] },
  { template: 'json-transform', patterns: [/\bjson\b.*\b(transform|convert|reshape|map)\b/i, /\btransform\b.*\bjson\b/i] },
  { template: 'shell-script', patterns: [/\b(bash|shell) script\b/i, /\bshell-?script\b/i] },
  { template: 'error-i18n', patterns: [/\bi18n\b/i, /\blocali[sz]ation key/i, /\bford[ií]t[aá]si kulcs/i] },

  // Type/interface work.
  { template: 'type-def', patterns: [/\b(type|interface) (definition|def)\b/i, /\btypescript (type|interface)\b/i, /\btype union\b/i, /\bt[ií]pus-?defin[ií]ci/i] },

  // Tests: full suite beats a single scaffold, so it is checked first.
  { template: 'test-suite-full', patterns: [/\b(full|complete|whole) test suite\b/i, /\bteljes teszt-?sorozat/i] },
  { template: 'test-scaffold', patterns: [/\btest scaffold\b/i, /\bunit tests?\b/i, /\bwrite tests?\b/i, /\bteszt(et|eket)? [ií]rj\b/i] },

  // Text / language work.
  { template: 'translate', patterns: [/\btranslate\b/i, /\bford[ií]tsd\b/i, /\bford[ií]t[aá]s\b/i] },
  { template: 'keywords', patterns: [/\bkeywords?\b/i, /\bkulcssz[oó]/i, /\bextract tags?\b/i] },
  { template: 'summarize', patterns: [/\bsummar(y|ise|ize)\b/i, /\b[oö]sszefoglal/i] },
  { template: 'msg-triage', patterns: [/\btriage\b/i, /\bclassif(y|ication)\b.*\bmessages?\b/i] },

  // Product / planning shapes.
  { template: 'user-story', patterns: [/\buser stor(y|ies)\b/i, /\bfelhaszn[aá]l[oó]i t[oö]rt[eé]net/i] },
  { template: 'card-decompose', patterns: [/\bdecompose\b/i, /\bbreak (this )?down into (sub)?tasks\b/i, /\bbontsd (le|fel)\b/i] },
  { template: 'edge-cases', patterns: [/\bedge cases?\b/i, /\bhat[aá]resetek?\b/i] },
  { template: 'code-explain', patterns: [/\bexplain (this )?code\b/i, /\bmagyar[aá]zd el a k[oó]dot\b/i] },
]

/**
 * Pick the best template for a task description, or null when nothing fits well.
 *
 * @param description free-text task description (the prompt, or a short summary of it)
 * @returns a template name from {@link KNOWN_TEMPLATES}, or null for free-form chat
 */
export function pickTemplate(description: unknown): TemplateName | null {
  if (typeof description !== 'string') return null
  const text = description.trim()
  // Too short to carry a reliable signal. A two-word prompt matching "regex" is as likely to be
  // someone asking ABOUT regexes as asking FOR one.
  if (text.length < 12) return null
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(text)) return rule.template
    }
  }
  return null
}

/** True iff `name` is one this picker can return -- the allowlist the queue can trust. */
export function isPickableTemplate(name: unknown): name is TemplateName {
  return typeof name === 'string' && (KNOWN_TEMPLATES as readonly string[]).includes(name)
}
