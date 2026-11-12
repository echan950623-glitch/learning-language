"use client";
import { useEffect, useState } from "react";
import { mutateRepository, waitForRepositoryInitialization } from "@/repository";
import { subscribeDataChanged } from "@/repository/accountStorage";
import { clearQuestionReports, formatQuestionReports, listQuestionReports, type QuestionReport } from "@/repository/questionReports";

/** Flagged questions on this device, ready to paste into a conversation about fixing them. */
export function QuestionReportsPanel() {
  const [reports, setReports] = useState<QuestionReport[]>([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) setReports(listQuestionReports()); };
    void waitForRepositoryInitialization().then(refresh).catch(() => undefined);
    const unsubscribe = subscribeDataChanged(refresh);
    return () => { active = false; unsubscribe(); };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(formatQuestionReports(reports));
      setMessage("已複製，貼給 Claude 就能修題目。");
    } catch {
      setMessage("無法自動複製，請改用下方文字手動複製。");
    }
  }
  async function clear() {
    try {
      await mutateRepository(() => clearQuestionReports());
      setReports([]);
      setMessage("已清除。被回報的題目會重新出現，除非已修正。");
    } catch {
      setMessage("清除失敗，請重新整理後再試。");
    }
  }

  return (
    <section aria-labelledby="question-reports" className="border-t border-border pt-5">
      <h2 id="question-reports" className="text-sm font-medium text-foreground">題目回報</h2>
      <p className="mt-1 text-xs leading-5 text-foreground-muted">作答後按「這題有問題」會把題目記在這台裝置並暫停出題，不會同步到其他裝置。把內容貼給 Claude，修正後的題目會換新的編號。</p>
      {reports.length === 0 ? <p className="mt-3 text-sm text-foreground-muted">目前沒有回報。</p> : (
        <>
          <p className="mt-3 text-sm text-foreground">{reports.length} 題已回報</p>
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={copy} className="min-h-12 flex-1 rounded-xl border border-foreground px-4 text-sm font-semibold text-foreground">複製回報內容</button>
            <button type="button" onClick={clear} className="min-h-12 rounded-xl border border-border px-4 text-sm text-foreground-muted">清除</button>
          </div>
          <textarea readOnly value={formatQuestionReports(reports)} aria-label="回報內容" rows={6} className="mt-3 w-full rounded-xl border border-border bg-transparent p-3 text-xs leading-5 text-foreground-muted" />
        </>
      )}
      {message ? <p role="status" className="mt-3 text-xs text-foreground-muted">{message}</p> : null}
    </section>
  );
}
