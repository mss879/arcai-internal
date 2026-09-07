"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Textarea } from "@/components/ui/input";
import type { AiProjectStatus } from "@/lib/types";

import { saveAllowedOrigins } from "./deploy-actions";

export type DeployPanelData = {
  id: string;
  status: AiProjectStatus;
  publicKey: string;
  allowedOrigins: string[];
  crmOrigin: string | null;
  websiteUrl: string | null;
};

export function DeployPanel({ data }: { data: DeployPanelData }) {
  const [origins, setOrigins] = React.useState(data.allowedOrigins.join("\n"));
  const [saving, setSaving] = React.useState(false);
  const [previewKey, setPreviewKey] = React.useState(0);
  const host = data.crmOrigin ?? (typeof window !== "undefined" ? window.location.origin : "https://<crm-host>");
  const snippet = `<script src="${host}/ai-widget.js" data-project="${data.publicKey}" async></script>`;
  const nextSnippet = `// app/layout.tsx\nimport Script from "next/script";\n\n// inside <body>, after {children}:\n<Script src="${host}/ai-widget.js" data-project="${data.publicKey}" strategy="afterInteractive" />`;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error("Couldn't copy");
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await saveAllowedOrigins(data.id, origins);
      if (res.ok) {
        setOrigins(res.origins.join("\n"));
        toast.success(res.origins.length ? "Allowed origins saved" : "Allowed origins cleared");
      } else toast.error(res.error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {data.status !== "active" && (
        <Alert variant="info">
          The project is {data.status === "draft" ? "a draft" : data.status}: the snippet works only in the preview below. Set it to Live on the Overview tab when the client&apos;s site is ready.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>The snippet</CardTitle>
              <CardDescription>One line, anywhere in the client&apos;s HTML. Nothing else of the agent ever leaves this CRM.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-emerald-300">{snippet}</code>
              <button type="button" onClick={() => copy(snippet, "Snippet")} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Copy snippet">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">Next.js (App Router)</p>
              <div className="flex items-start gap-2 rounded-xl bg-slate-900 px-3 py-2.5">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-slate-200">{nextSnippet}</code>
                <button type="button" onClick={() => copy(nextSnippet, "Next.js snippet")} className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Copy Next.js snippet">
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <ul className="space-y-1.5 text-xs text-slate-500">
              <li>• If the site sends a Content-Security-Policy, it must allow <code className="font-mono">{host}</code> in <code className="font-mono">script-src</code>, <code className="font-mono">connect-src</code> and (for the avatar) <code className="font-mono">img-src</code>.</li>
              <li>• The widget opens on <code className="font-mono">window.arcAi.open()</code> and can be asked a question with <code className="font-mono">window.arcAi.ask(&quot;…&quot;)</code>, so a &ldquo;Chat with us&rdquo; button on the site can drive it.</li>
              <li>• Rotating the key on the Overview tab means updating this snippet.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-slate-400" /> Allowed origins
              </CardTitle>
              <CardDescription>The websites that may use this key. Anything else is refused, whatever it sends. This CRM is always allowed, for the preview.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field hint="One per line. example.com (any scheme) · https://www.example.com · *.example.com (every subdomain) · http://localhost:3000 for the client's dev server.">
              <Textarea rows={6} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder={data.websiteUrl ? new URL(data.websiteUrl).host : "www.example.com"} className="font-mono text-[13px]" />
            </Field>
            <div className="flex items-center justify-between gap-2">
              {data.websiteUrl && !origins.trim() && (
                <button type="button" className="text-xs text-primary-700 hover:underline" onClick={() => { try { setOrigins(new URL(data.websiteUrl!).host); } catch { /* ignore */ } }}>
                  Use the project&apos;s website
                </button>
              )}
              <Button onClick={save} loading={saving} className="ml-auto">
                Save origins
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Live preview</CardTitle>
            <CardDescription>The real widget, on a stand-in page. Conversations here are marked preview: shown in analytics, never billed, never emailed to the client.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPreviewKey((k) => k + 1)}>
              <RefreshCw className="h-4 w-4" /> Reload
            </Button>
            <a href={`/ai-preview/${data.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-medium text-primary-700 hover:underline">
              Open in a tab <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </CardHeader>
        <CardContent>
          <iframe
            key={previewKey}
            src={`/ai-preview/${data.id}`}
            title="Widget preview"
            className="h-[640px] w-full rounded-xl border border-slate-200 bg-white"
          />
        </CardContent>
      </Card>
    </div>
  );
}
