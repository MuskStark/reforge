"use client";

/**
 * 后台 · 外部通知渠道:把项目的关键动态转发到企业微信 / 钉钉 / 飞书群机器人或邮箱。
 * 转发由后端在站内通知写入之后异步完成,失败会按退避重试;这里只做配置、启停与测试。
 * Webhook 地址与密钥是凭据:接口只返回脱敏值,修改时留空表示不改。
 */

import { useCallback, useEffect, useState } from "react";
import { BellRing, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogActions, DialogHeader, Field } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth";
import { fmtDateTime } from "@/lib/labels";
import type { ChannelKind, NotifyChannel, NotifyChannelInput, NotifyChannelList } from "@/lib/types";
import { cn } from "@/lib/utils";

const API = "/api/admin/notify-channels";

const KIND_LABEL: Record<ChannelKind, string> = { wecom: "企业微信", dingtalk: "钉钉", feishu: "飞书", email: "邮件" };
const KINDS: ChannelKind[] = ["wecom", "dingtalk", "feishu", "email"];
const BOT_KINDS: ChannelKind[] = ["wecom", "dingtalk", "feishu"];

const SECRET_HINT: Record<ChannelKind, string> = {
  wecom: "企业微信机器人不需要签名。安全设置如果用了「自定义关键词」，请把关键词设为 ReForge。",
  dingtalk: "安全设置勾选了「加签」时填写（以 SEC 开头）。用「自定义关键词」时关键词请设为 ReForge。",
  feishu: "安全设置勾选了「签名校验」时填写。用「自定义关键词」时关键词请设为 ReForge。",
  email: "",
};

interface FormState {
  name: string;
  kind: ChannelKind;
  webhook: string;
  secret: string;
  clearSecret: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpPass: string;
  clearPass: boolean;
  smtpFrom: string;
  recipients: string;
  kinds: string[];
}

const isBot = (k: ChannelKind) => BOT_KINDS.includes(k);

function summaryOf(ch: NotifyChannel): string {
  if (isBot(ch.kind)) return ch.webhook;
  const n = ch.recipients.split(/[,;\n]/).filter((s) => s.trim()).length;
  return `${ch.smtpHost}:${ch.smtpPort}${ch.smtpUser ? ` · ${ch.smtpUser}` : ""} · 发件 ${ch.smtpFrom} · 收件 ${n} 人`;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn("relative h-[26px] w-[44px] shrink-0 rounded-full transition-colors", checked ? "bg-[color:var(--green)]" : "bg-[rgba(120,120,128,0.28)]")}
    >
      <span className={cn("absolute top-[2px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.22)] transition-all", checked ? "left-[20px]" : "left-[2px]")} />
    </button>
  );
}

export function NotifyChannels({ onLogout }: { onLogout: () => void }) {
  const [data, setData] = useState<NotifyChannelList | null>(null);
  const [editing, setEditing] = useState<NotifyChannel | "new" | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [askRemove, setAskRemove] = useState<NotifyChannel | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await authFetch<NotifyChannelList>(API, { cache: "no-store" }));
    } catch (e) {
      if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
      else toast.error("读取失败", { description: "无法获取通知渠道" });
    }
  }, [onLogout]);

  useEffect(() => {
    void load();
  }, [load]);

  // 关闭表单要同时清掉"正在编辑"与表单内容:对话框跟着表单内容显示,只清其中一个会留下一张空表单
  const closeForm = () => {
    setEditing(null);
    setForm(null);
  };

  const kindLabel = (k: string) => data?.kinds.find((x) => x.kind === k)?.label ?? k;

  const openNew = () => {
    setEditing("new");
    setForm({
      name: "",
      kind: "wecom",
      webhook: "",
      secret: "",
      clearSecret: false,
      smtpHost: "",
      smtpPort: "465",
      smtpUser: "",
      smtpPass: "",
      clearPass: false,
      smtpFrom: "",
      recipients: "",
      kinds: [...(data?.defaultKinds ?? [])],
    });
  };

  const openEdit = (ch: NotifyChannel) => {
    setEditing(ch);
    setForm({
      name: ch.name,
      kind: ch.kind,
      webhook: ch.webhook,
      secret: "",
      clearSecret: false,
      smtpHost: ch.smtpHost,
      smtpPort: String(ch.smtpPort),
      smtpUser: ch.smtpUser,
      smtpPass: "",
      clearPass: false,
      smtpFrom: ch.smtpFrom,
      recipients: ch.recipients,
      kinds: [...ch.kinds],
    });
  };

  const fail = (e: unknown, title: string) => {
    if (e instanceof Error && e.message === "UNAUTHORIZED") onLogout();
    else toast.error(title, { description: e instanceof Error && e.message !== "UNAUTHORIZED" ? e.message : "请重试" });
  };

  const save = async () => {
    if (!form || !editing) return;
    if (!form.name.trim()) {
      toast.error("请填写渠道名称");
      return;
    }
    const bot = isBot(form.kind);
    const maskedUntouched = bot && editing !== "new" && form.webhook.includes("****");
    if (bot && !maskedUntouched && !form.webhook.trim()) {
      toast.error("请填写机器人 Webhook 地址");
      return;
    }
    if (!bot && (!form.smtpHost.trim() || !form.smtpFrom.trim() || !form.recipients.trim())) {
      toast.error("请填写邮件服务器、发件人与收件人");
      return;
    }
    const body: NotifyChannelInput = {
      name: form.name.trim(),
      kind: form.kind,
      smtpHost: form.smtpHost.trim(),
      smtpPort: Number(form.smtpPort) || 465,
      smtpUser: form.smtpUser.trim(),
      smtpFrom: form.smtpFrom.trim(),
      recipients: form.recipients.trim(),
      kinds: form.kinds,
    };
    // 凭据:脱敏值原样传回或留空 = 不改;只有填了新值才随请求发出
    if (bot && !maskedUntouched) body.webhook = form.webhook.trim();
    if (form.secret.trim()) body.secret = form.secret.trim();
    if (form.clearSecret) body.clearSecret = true;
    if (form.smtpPass) body.smtpPass = form.smtpPass;
    if (form.clearPass) body.clearPass = true;

    setBusy(true);
    try {
      await authFetch<NotifyChannel>(editing === "new" ? API : `${API}/${editing.id}`, { method: editing === "new" ? "POST" : "PATCH", body: JSON.stringify(body) });
      closeForm();
      toast.success(editing === "new" ? "渠道已创建" : "渠道已保存", { description: "建议点「测试」确认能收到消息" });
      void load();
    } catch (e) {
      fail(e, "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (ch: NotifyChannel) => {
    try {
      const updated = await authFetch<NotifyChannel>(`${API}/${ch.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !ch.enabled }) });
      setData((prev) => (prev ? { ...prev, list: prev.list.map((x) => (x.id === updated.id ? updated : x)) } : prev));
      toast.success(updated.enabled ? `「${updated.name}」已启用` : `「${updated.name}」已停用`);
    } catch (e) {
      fail(e, "操作失败");
    }
  };

  const test = async (ch: NotifyChannel) => {
    setTesting(ch.id);
    try {
      const res = await authFetch<{ ok: boolean; error?: string }>(`${API}/${ch.id}/test`, { method: "POST" });
      if (res.ok) toast.success("测试消息已发送", { description: `请到「${ch.name}」确认收到` });
      else toast.error("测试失败", { description: res.error ?? "请检查配置" });
    } catch (e) {
      fail(e, "测试失败");
    } finally {
      setTesting(null);
    }
  };

  const remove = async () => {
    if (!askRemove) return;
    try {
      await authFetch(`${API}/${askRemove.id}`, { method: "DELETE" });
      setData((prev) => (prev ? { ...prev, list: prev.list.filter((x) => x.id !== askRemove.id) } : prev));
      toast.success("已删除", { description: `「${askRemove.name}」` });
    } catch (e) {
      fail(e, "删除失败");
    } finally {
      setAskRemove(null);
    }
  };

  const list = data?.list ?? [];
  const editingChannel = editing !== "new" && editing ? editing : null;

  return (
    <section>
      <div className="mb-3.5 flex flex-wrap items-center gap-3">
        <h2 className="flex items-center gap-2 text-[22px] font-bold tracking-[-0.02em]">
          通知渠道
          <span className="badge badge-plain">{list.length}</span>
        </h2>
        <p className="text-xs text-[color:var(--ink-2)]">把项目的关键动态转发到群机器人或邮箱，每 15 秒投递一次</p>
        <button type="button" onClick={openNew} className="btn btn-primary ml-auto !h-10">
          <Plus className="h-4 w-4" /> 新建渠道
        </button>
      </div>

      <div className="glass-card p-3 sm:p-4">
        {data && list.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-black/10 bg-white/30 px-4 py-8 text-center">
            <BellRing className="mx-auto h-7 w-7 text-[color:var(--ink-3)]" />
            <p className="mt-2 text-[15px] font-semibold text-neutral-900">还没有外部通知渠道</p>
            <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-[color:var(--ink-2)]">
              建一个群机器人渠道，评审提交、通过、驳回、逾期这些关键动态就会自动出现在群里；站内通知不受影响。
            </p>
          </div>
        ) : (
          <ul className="grid gap-2.5">
            {list.map((ch) => (
              <li key={ch.id} className="rounded-2xl bg-white/50 px-3.5 py-3 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.65),inset_0_0_0_0.5px_rgba(0,0,0,0.04)]">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-full", ch.enabled ? "bg-[color:var(--tint-soft)] text-[color:var(--tint)]" : "bg-[rgba(120,120,128,0.12)] text-[color:var(--ink-3)]")}>
                    <BellRing className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2 text-[15px] font-medium text-neutral-900">
                      {ch.name}
                      <span className={cn("badge !h-[20px] text-[11px]", isBot(ch.kind) ? "badge-blue" : "badge-amber")}>{KIND_LABEL[ch.kind]}</span>
                    </span>
                    <span className="font-data mt-0.5 block truncate text-[11px] text-[color:var(--ink-3)]" title={summaryOf(ch)}>
                      {summaryOf(ch)}
                    </span>
                  </span>
                  <Switch checked={ch.enabled} onChange={() => void toggle(ch)} label={`${ch.enabled ? "停用" : "启用"} ${ch.name}`} />
                  <button type="button" onClick={() => void test(ch)} disabled={testing === ch.id} className="btn btn-glass !h-9 !px-3 text-[13px] disabled:opacity-50">
                    <Send className="h-3.5 w-3.5" /> {testing === ch.id ? "发送中…" : "测试"}
                  </button>
                  <button type="button" onClick={() => openEdit(ch)} className="icon-btn !h-9 !w-9" aria-label={`编辑 ${ch.name}`} title="编辑">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={() => setAskRemove(ch)} className="icon-btn icon-danger !h-9 !w-9" aria-label={`删除 ${ch.name}`} title="删除">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-[color:var(--sep)] pt-2.5">
                  <span className="text-xs text-[color:var(--ink-2)]">转发</span>
                  {ch.kinds.slice(0, 7).map((k) => (
                    <span key={k} className="badge badge-plain !h-[20px] !px-2 text-[11px]">
                      {kindLabel(k)}
                    </span>
                  ))}
                  {ch.kinds.length > 7 && <span className="text-xs text-[color:var(--ink-3)]">+{ch.kinds.length - 7}</span>}
                  <span className={cn("ml-auto min-w-0 truncate text-xs", ch.lastError ? "text-[color:var(--red-deep)]" : "text-[color:var(--ink-3)]")} title={ch.lastError || undefined}>
                    {ch.lastError ? `最近一次发送失败：${ch.lastError}` : ch.lastSentAt ? `最近发送 ${fmtDateTime(ch.lastSentAt)}` : "尚未发送过"}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
        同一件事通知了多个人时，群里只发一条；消息以「ReForge 流程再造」开头。新渠道只转发创建之后产生的通知，不回放历史。
        Webhook 地址与密钥保存后不再显示，修改时留空表示不改。
      </p>

      {form && (
        <Dialog onClose={() => closeForm()} labelledBy="channel-form-title" className="max-w-[640px]">
          <DialogHeader
            id="channel-form-title"
            title={editing === "new" ? "新建通知渠道" : `编辑「${editingChannel?.name ?? ""}」`}
            subtitle="保存后约 15 秒内生效；只转发此后新产生的通知。"
            onClose={() => closeForm()}
          />
          <div className="mt-5 grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="渠道名称" required>
                <Input value={form.name} placeholder="如：流程改造管理群" autoComplete="off" onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="类型">
                <select className="field" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ChannelKind })}>
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                      {isBot(k) ? "群机器人" : "（SMTP）"}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {isBot(form.kind) ? (
              <div className="grid gap-4">
                <Field label="机器人 Webhook 地址" required hint={editing !== "new" ? "未改动就保持打码的地址" : "地址里的 key 就是凭据"}>
                  <Input
                   
                    value={form.webhook}
                    placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
                    autoComplete="off"
                    onChange={(e) => setForm({ ...form, webhook: e.target.value })}
                  />
                </Field>
                <div className="space-y-1.5">
                  <Field label="签名密钥" hint={SECRET_HINT[form.kind]} htmlFor="ch-secret">
                    <div className="flex gap-2">
                      <Input
                        id="ch-secret"
                        type="password"
                        value={form.secret}
                        autoComplete="new-password"
                        placeholder={editing !== "new" && editingChannel?.secretSet && !form.clearSecret ? "已设置，留空则不改" : "选填"}
                        onChange={(e) => setForm({ ...form, secret: e.target.value })}
                      />
                      {editing !== "new" && editingChannel?.secretSet && !form.clearSecret && (
                        <button type="button" onClick={() => setForm({ ...form, secret: "", clearSecret: true })} className="btn btn-glass !h-11 shrink-0 !px-3 text-[13px]">
                          清除
                        </button>
                      )}
                    </div>
                  </Field>
                  {form.clearSecret && <p className="-mt-1 text-xs text-[color:var(--amber-deep)]">保存后将清除签名密钥。</p>}
                </div>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="SMTP 服务器" required>
                  <Input value={form.smtpHost} placeholder="smtp.example.com" autoComplete="off" onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} />
                </Field>
                <Field label="端口" hint="465 走 SSL，其余端口在服务器支持时升级加密">
                  <Input inputMode="numeric" value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: e.target.value })} />
                </Field>
                <Field label="用户名" hint="选填">
                  <Input value={form.smtpUser} autoComplete="off" onChange={(e) => setForm({ ...form, smtpUser: e.target.value })} />
                </Field>
                <div className="space-y-1.5">
                  <Field label="密码 / 授权码" hint="选填" htmlFor="ch-pass">
                    <div className="flex gap-2">
                      <Input
                        id="ch-pass"
                        type="password"
                        value={form.smtpPass}
                        autoComplete="new-password"
                        placeholder={editing !== "new" && editingChannel?.smtpPassSet && !form.clearPass ? "已设置，留空则不改" : ""}
                        onChange={(e) => setForm({ ...form, smtpPass: e.target.value })}
                      />
                      {editing !== "new" && editingChannel?.smtpPassSet && !form.clearPass && (
                        <button type="button" onClick={() => setForm({ ...form, smtpPass: "", clearPass: true })} className="btn btn-glass !h-11 shrink-0 !px-3 text-[13px]">
                          清除
                        </button>
                      )}
                    </div>
                  </Field>
                  {form.clearPass && <p className="-mt-1 text-xs text-[color:var(--amber-deep)]">保存后将清除密码。</p>}
                </div>
                <Field label="发件人地址" required>
                  <Input value={form.smtpFrom} placeholder="reforge@example.com" autoComplete="off" onChange={(e) => setForm({ ...form, smtpFrom: e.target.value })} />
                </Field>
                <Field label="收件人" required hint="多人用逗号分隔">
                  <Input value={form.recipients} placeholder="pm@example.com, cto@example.com" autoComplete="off" onChange={(e) => setForm({ ...form, recipients: e.target.value })} />
                </Field>
              </div>
            )}

            <Field label="转发哪些通知" hint="全不选则恢复默认范围">
              <div className="flex flex-wrap gap-1.5">
                {(data?.kinds ?? []).map((k) => {
                  const on = form.kinds.includes(k.kind);
                  return (
                    <button
                      key={k.kind}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setForm({ ...form, kinds: on ? form.kinds.filter((x) => x !== k.kind) : [...form.kinds, k.kind] })}
                      className={cn(
                        "rounded-full px-3 py-1.5 text-[13px] transition shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.06)]",
                        on ? "bg-[color:var(--tint)] font-medium text-white" : "bg-white/55 text-[color:var(--ink-2)] hover:bg-white/85",
                      )}
                    >
                      {k.label}
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => setForm({ ...form, kinds: [...(data?.defaultKinds ?? [])] })} className="text-xs font-medium text-[color:var(--tint)] hover:underline">
                  恢复默认
                </button>
                <button type="button" onClick={() => setForm({ ...form, kinds: (data?.kinds ?? []).map((k) => k.kind) })} className="text-xs font-medium text-[color:var(--tint)] hover:underline">
                  全选
                </button>
              </div>
            </Field>
          </div>
          <DialogActions>
            <button type="button" onClick={() => closeForm()} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => void save()} disabled={busy} className="btn btn-primary disabled:opacity-60">
              保存
            </button>
          </DialogActions>
        </Dialog>
      )}

      {askRemove && (
        <Dialog onClose={() => setAskRemove(null)} labelledBy="channel-remove-title">
          <DialogHeader id="channel-remove-title" title={`删除渠道「${askRemove.name}」？`} subtitle="删除后不再向这里转发通知；站内通知不受影响。" onClose={() => setAskRemove(null)} />
          <DialogActions>
            <button type="button" onClick={() => setAskRemove(null)} className="btn btn-glass">
              取消
            </button>
            <button type="button" onClick={() => void remove()} className="btn btn-glass text-[color:var(--red-deep)]">
              删除
            </button>
          </DialogActions>
        </Dialog>
      )}
    </section>
  );
}
