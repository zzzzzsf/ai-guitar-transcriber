/**
 * 吉他场景 System Prompts（v4.0 §4.2 三大 BYOK 特性）。
 *
 * 约束来源：
 * - 输出契约走 JSON/纯 alphaTex，配合 llmClient.extractJson + texGuard 前置校验（§1.3）；
 * - AI 改谱必须保留 \tempo 标记与分段（v4.1 §3.5 BYOK 约束）。
 */

/** 谱面文本塞进 prompt 的上限 —— 4 分钟谱约 2~3k token，超长曲截断并提示 */
export const PROMPT_TEX_LIMIT = 12_000;

export function clampTexForPrompt(alphaTex: string, limit = PROMPT_TEX_LIMIT): string {
  if (alphaTex.length <= limit) return alphaTex;
  const cut = alphaTex.slice(0, limit);
  const lastBar = cut.lastIndexOf('|');
  return `${lastBar > 0 ? cut.slice(0, lastBar + 1) : cut}\n…（后续小节已截断，仅标注以上部分）`;
}

// ---------- ① 自动和弦标注 ----------

export const CHORD_SYSTEM_PROMPT = `你是一名资深吉他乐理编辑，任务是为六线谱（alphaTab 的 alphaTex 文本）逐小节标注和弦。

输出契约（必须严格遵守）：
- 只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。
- 结构：{"chords":[{"bar":<小节号,从1开始>,"name":"<和弦名>"}, ...]}
- 只给有音符的小节标注；按 bar 升序；每个小节至多一条。
- 和弦名规范：根音大写字母（C C# D D# E F F# G G# A A# B），后接质量后缀：
  m / 7 / m7 / maj7 / sus2 / sus4 / dim / aug / add9 / m7b5 / 6 / 9 / 5（强力和弦）；
  转位/指定低音写斜杠，如 "D/F#"、"Am/E"。
- 判断依据：小节内音符的音高集合与节拍重音（时值长、位于强拍的音更可能是和弦音）；
  相邻小节倾向平滑进行（常见 145/1645/卡农进行），但不要为了平滑硬凑明显不合音高的和弦。`;

export function buildChordUserPrompt(alphaTex: string, barCount: number, key?: string): string {
  const keyLine = key ? `参考调性：${key}（可能与实际出入，仅作提示）。` : '调性未知，自行判断。';
  return `下面是一首吉他曲的 alphaTex 六线谱（共 ${barCount} 小节）。${keyLine}
谱面中 ":时值 弦.品" 是音符，"|" 分隔小节，"\\tempo" 是速度标记。

${clampTexForPrompt(alphaTex)}

请逐小节分析和弦，按输出契约返回 JSON。`;
}

// ---------- ② AI 改谱（把位重构 / 新手降维 / 错音清洗） ----------

export const REWRITE_SYSTEM_PROMPT = `你是一名吉他编配专家。用户会给你一段 alphaTex 六线谱和一个改编要求，你返回改编后的完整 alphaTex 文本。

规则（必须严格遵守）：
1. 只输出 alphaTex 文本本身，不要解释、不要代码块围栏。
2. 语法保持不变：":时值 弦.品" 音符、"{效果}" 标注、"| \\tempo 速度" 等元命令原样保留。
3. "\\tempo" 速度标记与分段结构一律不得删除、不得修改、不得新增（变速信息来自音频检测，是硬约束）。
4. 小节数量保持不变（除非用户要求增删小节）。
5. 改编只作用于音符的弦.品选择、时值简化、技巧标注，音高序列除非用户明确要求否则不改。
6. 改完自查一遍语法可解析（括号/竖线配对、音符格式完整）。`;

export function buildRewriteUserPrompt(alphaTex: string, instruction: string, context?: string): string {
  const ctx = context ? `\n补充上下文：${context}` : '';
  return `改编要求：${instruction}${ctx}

原谱（alphaTex）：
${alphaTex}

请返回改编后的完整 alphaTex 文本。`;
}

// ---------- ③ 双吉他拆轨（Lead / Rhythm） ----------

export const SPLIT_SYSTEM_PROMPT = `你是一名吉他编配专家。用户给你一段单轨 alphaTex 六线谱，你把它拆成 Lead（主音/旋律）与 Rhythm（节奏/伴奏）两轨。

输出契约（必须严格遵守）：
- 只输出一个 JSON 对象：{"lead":"<alphaTex 文本>","rhythm":"<alphaTex 文本>"}，不要解释、不要代码块。
- 两轨语法合法、小节数与原谱一致；原谱每个音符至少属于其中一轨；两轨不重叠同一时间点的相同音高。
- "\\tempo" 标记两轨都要保留（播放时同步）。`;

export function buildSplitUserPrompt(alphaTex: string): string {
  return `原谱（单轨 alphaTex，${alphaTex.split('|').length - 1} 小节）：

${clampTexForPrompt(alphaTex)}

请拆分为 Lead 与 Rhythm 双轨，按输出契约返回 JSON。`;
}
