# Automation introduction image

Generated with the built-in `image_gen` tool. Conceptual promotional artwork, not a product screenshot.

## Visual reference

[Official DeepSeek Harness website](https://www.deepseek.com/harness/), inspected on 2026-09-17: dark navy and black surfaces, atmospheric blue light, subtle grid and square-dot textures, translucent panels, Montserrat headings and DM Sans body text with Chinese sans-serif fallbacks.

The generation used screenshots of the Chinese homepage hero and the Harness capabilities section as style references. Replaces the initial light infographic after user feedback.

## Base artwork prompt

```text
Use case: ads-marketing / stylized-concept.
Create a completely redesigned product hero poster for the open-source DSH plugin "dsh-automation", landscape 1536x1024. Use the supplied official DeepSeek Harness website screenshots as STYLE REFERENCES only, not as a screenshot to reproduce. Reference 1 is the homepage hero; reference 2 its pixel-accent dark design section. Match this specific visual language closely.

DESIGN DIRECTION
A dramatic yet quiet DeepSeek Harness ecosystem product image, an original visual metaphor of agent work recurring through time. Visually rich illustration first, minimal words. NOT a text-heavy infographic, not a numbered flowchart, not a generic dashboard, not a white slide.
Background matches official site: almost-black #0A0A0A base, deep slate/navy #142233 into muted #244D79 atmospheric light across the upper right, delicate barely visible large technical grid, beautifully subtle silver-blue translucent folds of light and fine square-dot particle texture. Keep clean readable high-contrast white foreground, avoid fog over letters.
Composition: generous margins. Left 40 percent is quiet typography with a small glass pill identifying the plugin ecosystem, then the product name and a two-line Chinese headline. Right 60 percent and lower center is a sophisticated bespoke 3D/2.5D illustration: an elegant tilted translucent smoked-glass clock dial with a silver-blue rim, a thin orbit of small square pixel particles representing scheduled recurrence, and three tangible translucent task tiles at different points of that time orbit. The clock and modules are large expressive objects, no flat clip-art clock. A fine luminous line flows from a small terminal-style prompt surface in the lower left through the time orbit to one completed-task panel in the front right. It must feel like work progressing through time, not random floating rectangles. The completed-task panel should be the crispest foreground object, dark smoked glass with a small subdued green completion mark, document lines and the task name, physically integrated with the composition. A few fine pixel squares break off the orbit echoing the website's DSH particle/pixel design. Restrained realistic materials and depth, studio-quality soft blue side-light, no rainbow, neon purple, science-fiction spaceship, robots, gears, stock illustrations or excessive glowing rings.

TYPE
Modern medium-weight geometric sans like Montserrat for the English product title, clean PingFang/Noto Sans Chinese with calm medium weight. Small technical labels use monospaced type. Inspired by the official HARNESS pixel-accent word, the small "AUTOMATION" eyebrow may use tasteful square-pixel letterforms. Do NOT use heavy bold slab text or huge black lettering.

Only the following text, verbatim:
Top-left subtle small glass pill: "DeepSeek Harness 插件"
Small blue technical eyebrow: "AUTOMATION"
Product name: "dsh-automation"
Main Chinese headline, two lines: "让重复的工作" / "按时发生。"
Small supporting line: "一句话安排，Agent 按计划执行。"
On the low-left terminal-like prompt surface, only: "> 每个工作日 18:00，整理今日改动"
Small time orbit task tiles may contain ONLY these short pairs: "09:00" and "发布检查"; "09:30" and "依赖巡检"; "18:00" and "每日交接".
Completed front task panel: "每日交接" and "已完成"; below the title use abstract document lines, no invented small text.
Tiny muted footer: "单次 / 周期 · 结果可追溯"
Tiny bottom-right caption: "功能示意"

LAYOUT PRIORITIES
Illustration should occupy 65% of total visual attention. Large atmospheric hero image with a clear central focal point and beautiful depth. Left headline should be spacious, no paragraphs, no numbered steps, no separate feature grid. Ensure all required Chinese text is correct and legible, no duplicate labels except the specified repeated task name, no watermark. Do not include official DeepSeek corporate logo or imitate official endorsement; clearly a plugin named dsh-automation. This is conceptual promotional artwork, not a claim of real UI.
```

## Chinese feature edition

Edited with the built-in `image_gen` tool using the approved dark clock artwork as the edit target. Preserves the approved style and adds six product highlights plus result/history and run controls.

```text
Edit the attached dsh-automation promotional artwork. The user APPROVES this exact style, but wants MORE REAL PRODUCT HIGHLIGHTS. Preserve the approved black/navy palette, atmospheric blue light, glass materials, delicate technical grid, pixel particles, elegant geometric sans type, and the striking glass clock/time-orbit illustration. Do not revert to a white infographic, plain text slide, or generic corporate design.

Create a polished expanded feature edition, landscape 4:3, ideally 2048 x 1536, opaque background. Recompose intentionally: upper 60-64% remains the beautiful approved hero (left title, right glass clock, prompt leading to completed task); lower 30-34% becomes an integrated feature gallery with six concise capabilities, arranged in 3 columns and 2 rows. The gallery should blend into the navy scene with subtle glass surfaces, thin separators, small bespoke silver-blue translucent pictograms, spacious text, and no heavy boxes. Each capability should have a visually distinct meaningful icon (calendar, overlapping conversations, model/skill modular blocks, shield, outgoing message, pause within a protective ring). Do not make a wall of text. Artwork must still dominate the first glance; feature headings must be readable on the second glance. Typography a notch smaller than the original hero so the expanded composition breathes. Keep all content safely inside the canvas.

Preserve these hero texts exactly, with no other repeated headings:
"DeepSeek Harness 插件"
"AUTOMATION"
"dsh-automation"
"让重复的工作"
"按时发生。"
"一句话安排，Agent 按计划执行。"
Terminal example: "> 每个工作日 18:00，整理今日改动"
Two small orbit tiles: "09:00" / "发布检查", and "09:30" / "依赖巡检"
Completed task panel: "每日交接", "已完成".
Replace the abstract lines at the bottom of this completed task panel with a crisp tiny but legible line: "摘要 · 历史 · 会话"

Feature gallery MUST include ALL six of the following distinct pairs, exactly once each. Each item has one heading in white and one short supporting line in cool gray. No numbered steps, no large paragraphs:
1. "灵活调度" — "单次 / 周期 / 时区"
2. "会话延续" — "新建会话 / 固定会话"
3. "执行可选" — "Agent / 模型 / 技能"
4. "权限可控" — "权限预设 · 变更确认"
5. "消息投递" — "可选接入 dsh-im"
6. "失败保护" — "可选连续失败 3 次后暂停"

Add a quiet bottom utility strip separated by a fine line, with subtle control glyphs and only this text:
Left: "立即运行 · 暂停 · 恢复 · 停止"
Right small: "功能示意 · 运行时需保持 DSH 在线"

Truth constraints: dsh-im is OPTIONAL and must be labeled optional; automatic failure pause is OPTIONAL and threshold is three; do not invent cloud hosting, offline operation, automatic approval, guaranteed phone receipt, concurrent execution, or automatic retry. This is conceptual artwork, not a real UI screenshot. No official DeepSeek logo or endorsement. Keep every Chinese character sharp, complete, correct, and with generous contrast. Do not duplicate feature labels or add small filler text.
```

## English edition

Localized with the built-in `image_gen` tool using the approved Chinese feature edition as the edit target.

Final assets, in marketplace display order:

1. `automation-overview-en.png`
2. `automation-overview-zh.png`

```text
Use case: text-localization.
Edit this approved Chinese dsh-automation promotional image into a fully ENGLISH edition. Preserve the entire illustration, navy/black/blue palette, translucent glass clock and panels, orbit, pixel particles, six pictograms, composition, spacing and visual hierarchy. Preserve the landscape 4:3 aspect ratio and ideally the original 1448 x 1086 dimensions. Change ONLY the language and adjust text sizes and line wraps minimally to fit naturally. Do not recreate a different design. Every visible Chinese label must be replaced, including the footer, floating task cards, terminal, and all six feature items. English must be crisp and readable with no clipped or overlapping text. Use concise exact copy below. Do not add any other text or retain any Chinese.

Text replacements:
"DeepSeek Harness 插件" -> "DeepSeek Harness Plugin"
"AUTOMATION" stays "AUTOMATION"
"dsh-automation" stays "dsh-automation"
Main two-line headline "让重复的工作 / 按时发生。" -> "Recurring work." / "Right on time."
"一句话安排，Agent 按计划执行。" -> "One prompt. Your Agent runs on schedule."
Terminal text -> "> Weekdays at 18:00, summarize today's changes"
Orbit tile 1 -> "09:00" and "Release check"
Orbit tile 2 -> "09:30" and "Dependency review"
Completed panel -> "Daily handoff" and "Completed"
Completed panel lower line -> "Summary · History · Session"

Six feature groups in existing order, 3 columns x 2 rows. Keep the existing associated icons:
Top left heading "Flexible schedules"; supporting line "One-time / Recurring / Time zones"
Top middle heading "Session continuity"; supporting line "Fresh or pinned sessions"
Top right heading "Execution options"; supporting line "Agent / Model / Skills"
Bottom left heading "Permission control"; supporting line "Presets · Confirm changes"
Bottom middle heading "Message delivery"; supporting line "Optional dsh-im integration"
Bottom right heading "Failure protection"; supporting text on TWO short lines if needed: "Optional auto-pause after" / "3 consecutive failures"

Bottom control strip left -> "Run now · Pause · Resume · Stop"
Bottom right caption -> "Concept illustration · Keep DSH running"

Invariants: identical approved style and artwork; all six features present; optional qualifiers must remain for messaging and failure auto-pause; threshold remains 3 consecutive failures. No official endorsement or extra logo. Do not alter the Chinese original file; create the English variant.
```
