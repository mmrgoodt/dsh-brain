/**
 * tools.js —— 交给模型自己的三个动作
 *
 * 只有工具，没有自动抽取。
 * 上一版用正则去猜「这句算不算偏好」，结果把「不用做这个我需要你能更改设备的燃烧时间」
 * 当成了一条性格。谁在说这句话、说这话是什么意思，只有模型自己知道。
 * 所以：记什么、算哪类、要不要删，全交给模型决定，插件只负责存好、找得回来。
 */

let causeDb = null;
export function bindCauseDb(db) { causeDb = db; }
function requireCauseDb() {
  if (!causeDb) throw new Error('因果库没接上');
  return causeDb;
}

export function registerBrainTools(ctx, store, logger) {
  if (typeof ctx?.tools?.register !== 'function') {
    logger?.warn?.('dsh-brain: 没有 tools.register，工具注册不了');
    return () => {};
  }
  const disposers = [];

  // ── 记 ────────────────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_remember',
      description:
        '把一件事写进长期记忆。由你自己判断该不该记、算什么类型：\n' +
        '  identity   关于「他是谁」——身份、处境、看重什么\n' +
        '  preference 他要我怎么做——说话方式、习惯、不要什么\n' +
        '  fact       事实：环境、路径、配置、结论、数字\n' +
        '  lesson     教训：踩过的坑、别再犯的错\n' +
        '  method     可复用的做法、步骤\n' +
        '  episode    某天发生了什么事\n' +
        '规则：一件事一条，写成完整句子，不要「用户说了什么」这种转述。\n' +
        '同一件事重复记会被拦下来（只做强化），不会存两份。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要记住的内容，一句话说清一件事' },
          kind: {
            type: 'string',
            enum: ['identity', 'preference', 'fact', 'lesson', 'method', 'episode'],
            description: '记忆类型，默认 fact',
          },
          about: { type: 'string', description: '可选：主题词，便于以后按主题找' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选：几个关键词',
          },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            action: { type: 'string' },
            id: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (_a, r) => [{
          type: 'text',
          text: r?.ok
            ? `记住了：${r.action}${r.id ? ' ' + r.id : ''}${r.note ? '（' + r.note + '）' : ''}`
            : `没记住：${r?.error ?? '未知原因'}`,
        }],
      },
      execute: async ({ text, kind, about, tags }) => {
        const body = String(text || '').trim();
        if (!body) return { ok: false, error: '内容为空' };

        // 去重：已有的记忆和这条几乎一样 → 只强化，不再存一份
        const dup = store.items.find((m) => m.text === body);
        if (dup) {
          dup.weight += 0.5;
          dup.uses += 1;
          dup.lastUse = Date.now() / 1000;
          store.update(dup);
          return { ok: true, action: '强化', id: dup.id, note: '已经有这条了' };
        }
        const item = store.add({
          text: body,
          kind: kind || 'fact',
          about: about || '',
          tags: Array.isArray(tags) ? tags : [],
        });
        return { ok: true, action: '新增', id: item.id, note: `共 ${store.size} 条` };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_remember 注册失败 ${e}`);
  }

  // ── 想 ────────────────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_recall',
      description:
        '在自己的记忆里找。对话开头会自动带出相关的几条，这里用于：\n' +
        '想确认某件事记过没有、按具体关键词精确找、或者翻更早的记录。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要查的内容，用关键词而不是整句话' },
          limit: { type: 'integer', description: '返回几条，默认 8，最多 20' },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            memories: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string' },
                  text: { type: 'string' },
                  ts: { type: 'number' },
                },
              },
            },
          },
        },
        render: (_a, r) => {
          const list = r?.memories ?? [];
          if (!list.length) return [{ type: 'text', text: '没找到相关的记忆。' }];
          return [{
            type: 'text',
            text: list
              .map((m, i) => {
                const d = new Date(m.ts * 1000).toISOString().slice(0, 10);
                // 带上 id：brain_why / brain_cause 都要 id，不给的话拿不到手就没法追因果
                return `${i + 1}. [${m.kind}·${d}] (${m.id}) ${m.text}`;
              })
              .join('\n'),
          }];
        },
      },
      execute: async ({ query, limit }) => {
        const n = Math.min(20, Math.max(1, limit || 8));
        // 自己写一个宽松版：只按关键词命中，不看权重和新鲜度
        const { tokens } = await import('./text.js');
        const qs = tokens(query);
        const hits = [];
        for (const m of store.items) {
          if (m.status !== 'active') continue;
          const hay = tokens(m.text + ' ' + m.about + ' ' + m.tags.join(' '));
          let hit = 0;
          for (const t of qs) if (hay.has(t)) hit += 1;
          if (!hit) continue;
          hits.push({ m, hit });
        }
        // 分词全被停用词吃掉时（比如"重启回执"只剩"回执"），退一步按字面包含找
        if (!hits.length) {
          const raw = String(query || '').replace(/\s+/g, '');
          const frags = [];
          for (let i = 0; i + 2 <= raw.length; i += 1) frags.push(raw.slice(i, i + 2));
          for (const m of store.items) {
            if (m.status !== 'active') continue;
            const txt = m.text + ' ' + m.about + ' ' + m.tags.join(' ');
            let hit = 0;
            for (const f of frags) if (f && txt.includes(f)) hit += 1;
            if (hit) hits.push({ m, hit });
          }
        }
        hits.sort((a, b) => b.hit - a.hit || b.m.ts - a.m.ts);
        // 还是没有：给最近几条，别让调用方拿到空手而归
        if (!hits.length) {
          const recent = store.items
            .filter((m) => m.status === 'active')
            .sort((a, b) => b.m.ts - a.m.ts)
            .slice(0, n)
            .map((m) => ({ m, hit: 0 }));
          hits.push(...recent);
        }
        const picked = hits.slice(0, n);
        store.touch(picked.map((h) => h.m.id));
        return {
          ok: true,
          memories: picked.map(({ m }) => ({
            id: m.id, kind: m.kind, text: m.text, ts: m.ts, about: m.about,
          })),
        };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_recall 注册失败 ${e}`);
  }

  // ── 忘 ────────────────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_forget',
      description:
        '删掉一条记错的记忆（要 id）。真删，不留副本 —— 记错了就该干净地消失。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        },
        render: (_a, r) => [{
          type: 'text',
          text: r?.ok ? `删了：${r.note || ''}` : `没删成：${r?.error ?? '未知原因'}`,
        }],
      },
      execute: async ({ id }) => {
        const item = store.items.find((m) => m.id === id);
        if (!item) return { ok: false, error: '没有这条' };
        store.remove(id);
        return { ok: true, note: item.text.slice(0, 40) };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_forget 注册失败 ${e}`);
  }

  // ── 起名字 / 改名 ─────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_rename',
      description:
        '给自己起名字或改名。当他说「以后你就叫 X」「我叫你 X 吧」这类话时调用。\n' +
        '改名会写进 meta，并且自动留一条记忆（我现在叫X，以前叫Y）——名字是自我认知的一部分，不是贴纸。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: '新名字，1–12 个字，中文/字母/数字' },
          reason: { type: 'string', description: '可选：为什么改（他会这么说）' },
        },
        required: ['name'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        },
        render: (_a, r) => [{
          type: 'text',
          text: r?.ok ? `名字定了：${r.note}` : `没改成：${r?.error ?? '未知原因'}`,
        }],
      },
      execute: async ({ name, reason }) => {
        const r = store.rename ? store.rename(name, reason || '') : { ok: false, error: '这条记忆库不支持改名' };
        if (!r?.ok) return { ok: false, error: r?.error || '改名失败' };
        return { ok: true, note: r.previous ? `${r.name}（原名叫 ${r.previous}）` : r.name };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_rename 注册失败 ${e}`);
  }

  // ── 体检 ──────────────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_health',
      description: '记忆体检：过期的状态类事实、可疑因果、孤儿关系各有多少，并给出先清哪个的建议。感觉「库里有旧状态挂着」时用它。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, r) => {
          if (!r?.ok) return [{ type: 'text', text: '体检失败：' + (r?.error || '未知原因') }];
          const s = r.stats || {};
          return [{
            type: 'text',
            text: [
              `记忆 ${s.impressions} 条（active ${s.active}）· 关系 ${s.bonds} · 因果 ${s.causes}`,
              `过期未清 ${s.expired} 条 · 可疑因果 ${s.suspectCauses} 条`,
              r.advice,
            ].join('\n'),
          }];
        },
      },
      execute: async () => {
        try {
          const db = requireCauseDb();
          const { stats } = await import('./db.js');
          const s = stats(db);
          const parts = [];
          if (s.expired) parts.push(`先清 ${s.expired} 条过期状态记忆（已不再注入，但还留在库里）`);
          if (s.suspectCauses) parts.push(`复核 ${s.suspectCauses} 条可疑因果`);
          return {
            ok: true,
            stats: s,
            advice: parts.length ? parts.join('；') + '。' : '库里没有需要清的过期状态。',
          };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_health 注册失败 ${e}`);
  }

  // ── 接下来干什么 ──────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_next',
      description: '拿一份「现状材料」：每个项目最近停在哪、有哪些疑似没兑现的话。注意：这是原料不是结论，排序和取舍由你判断，别原样念给用户。不主动推送，被问才给。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { limit: { type: 'number', description: '要几条，默认 3' } },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, r) => {
          const list = r?.items || [];
          if (!list.length) return [{ type: 'text', text: '现在没有悬着的事，库里的活都收了。' }];
          const lines = list.map((it, i) => (i + 1) + '. [' + it.project + '] ' + it.text + '（' + it.why + '）');
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      execute: async ({ limit = 3 } = {}) => {
        const { suggestNext } = await import('./next.js');
        const n = Math.min(5, Math.max(1, Number(limit) || 3));
        return { ok: true, items: suggestNext(requireCauseDb(), { limit: n }) };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: brain_next 注册失败 ${e}`);
  }

  // ── 因果 ──────────────────────────────────────────────
  try {
    disposers.push(ctx.tools.register({
      name: 'brain_cause',
      description: '记一条因果关系：谁导致了谁。两端给记忆 id，必须给 evidence（证据 id，至少一条）。果不能早于因；会成环的不收。得出「因为 A 所以 B」的结论时写一条，别为凑数写。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          cause: { type: 'string', description: '因：记忆 id' },
          effect: { type: 'string', description: '果：记忆 id' },
          why: { type: 'string', description: '一句话说清为什么是它导致的' },
          evidence: { type: 'array', items: { type: 'string' }, description: '支撑证据的 id，至少一条' },
          kind: { type: 'string', description: 'direct / indirect / pathological，默认 direct' },
        },
        required: ['cause', 'effect', 'why', 'evidence'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, r) => [{ type: 'text', text: r?.ok ? '因果记下了：' + r.action + (r.note ? '（' + r.note + '）' : '') : '没记：' + r?.error }],
      },
      execute: async (args) => {
        const { addCause } = await import('./cause.js');
        return addCause(requireCauseDb(), Object.assign({}, args, { by: 'assistant' }));
      },
    }));

    disposers.push(ctx.tools.register({
      name: 'brain_why',
      description: '顺因果图追问：为什么是这样（up），或者这导致了什么（down）。越远 certainty 越低。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', description: '记忆 id（可选）' },
          query: { type: 'string', description: '关键词（没给 id 时用它找一条）' },
          dir: { type: 'string', description: 'up=为什么 / down=导致了什么，默认 up' },
          depth: { type: 'number', description: '追几层，默认 3' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_a, r) => [{
          type: 'text',
          text: r?.ok
            ? (r.chain.length ? r.chain.map((c) => '　'.repeat(c.depth - 1) + (c.dir === 'up' ? '←' : '→') + ' [' + c.kind + ' ' + c.certainty + '] ' + c.text).join('\n') : '这条记忆还没有因果边')
            : '没查到：' + r?.error,
        }],
      },
      execute: async ({ id, query, dir = 'up', depth = 3 }) => {
        const db2 = requireCauseDb();
        let target = id;
        if (!target && query) {
          const hit = store.items
            .filter((m) => m.status === 'active' && String(m.text || '').includes(String(query).slice(0, 12)))
            .sort((a, b) => b.mts - a.mts)[0];
          if (!hit) return { ok: false, error: '没找到对应记忆' };
          target = hit.id;
        }
        if (!target) return { ok: false, error: '要给 id 或者 query' };
        const { chain } = await import('./cause.js');
        return {
          ok: true, id: target,
          chain: chain(db2, String(target), { depth: Math.min(5, Math.max(1, Number(depth) || 3)), dir: dir === 'down' ? 'down' : 'up' }),
        };
      },
    }));
  } catch (e) {
    logger?.warn?.(`dsh-brain: 因果工具注册失败 ${e}`);
  }



  return () => {
    for (const d of disposers) {
      try { d?.(); } catch { /* 卸载时忽略 */ }
    }
  };
}
