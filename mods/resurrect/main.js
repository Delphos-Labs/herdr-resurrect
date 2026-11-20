import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { machines, spaces, theme, checking, exec } from "herdr";

const BRIDGE = `
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const {spawnSync} = require("node:child_process");
const configFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(),".config"),
  "herdr-resurrect/config.json");
let config;
try { config = JSON.parse(fs.readFileSync(configFile,"utf8")); } catch {
  console.error("Install or configure the native recorder on this host first."); process.exit(2);
}
const prefix = config.installDir || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(),".local/share"),
  "herdr-resurrect/current");
if (config.version !== 1 || !path.isAbsolute(prefix)) {
  console.error("Unsupported host recorder configuration."); process.exit(2);
}
const file = path.join(prefix,"bin/native-control.js");
if (!fs.existsSync(file)) { console.error("Install the native recorder on this host first."); process.exit(2); }
const result = spawnSync(process.execPath,[file,...JSON.parse(process.argv[1])],
  {stdio:"inherit",windowsHide:true});
process.exit(result.status ?? 1);
`;

export default class Resurrect extends View {
  init(_props, cx) {
    this.machine = spaces().find(space => space.active)?.machine ?? null;
    this.data = null;
    this.error = null;
    this.preview = null;
    this.reviewed = false;
    this.busy = false;
    this.snapshots = [];
    this.report = null;
    if (!checking()) {
      this.invoke("status", [], cx);
      cx.timer.every(15000, cx => {
        if (!this.busy) this.invoke("status", [], cx);
      });
    }
  }

  invoke(action, arguments_, cx) {
    if (this.busy) return;
    const machine = this.machine;
    this.busy = true;
    this.error = null;
    if (action === "restore") {
      this.preview = null;
      this.reviewed = false;
    }
    cx.notify();
    cx.spawn(async cx => {
      try {
        const result = await exec("node", ["-e", BRIDGE, JSON.stringify([action, ...arguments_])],
          { on: machine, timeout: action === "status" ? 10000 : 60000 });
        if (result.code !== 0) {
          let message = result.stderr || "The recovery command failed.";
          try {
            const failure = JSON.parse(message);
            message = failure.error || message;
            if (failure.resumedInPlace) message += ` ${failure.resumedInPlace} programs may already have resumed; preview again.`;
          } catch {}
          throw new Error(message);
        }
        const value = JSON.parse(result.stdout);
        if (this.machine !== machine) return;
        if (action === "status") this.data = value;
        else if (action === "list") this.snapshots = value;
        else if (action === "preview") {
          this.preview = value;
          this.reviewed = false;
          this.report = null;
        } else {
          this.report = value;
          if (action === "restore") {
            this.preview = null;
            this.reviewed = false;
          }
        }
      } catch (error) {
        if (this.machine === machine) this.error = String(error.message || error);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const targets = [null, ...machines().map(item => item.name).filter(name => name !== null)];
    const unique = [...new Set(targets)];
    const button = (id, text, enabled, action) => div().id(id).px(10).h(30).rounded(5)
      .flex().items_center().flex_none().text_size(12)
      .bg(enabled ? t.raised : t.chrome).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, element => element.cursor_pointer().hover(style => style.bg(t.hover))
        .on_click((_event, cx) => action(cx)))
      .child(text);
    const health = this.data?.health;
    const saved = this.data?.snapshot;
    const report = this.report || this.data?.lastRestore;
    const stamp = value => value ? new Date(value).toLocaleString() : "Never";
    return v_flex().size_full().min_h(0).p(18).gap(12).bg(t.surface).text_color(t.foreground)
      .child(div().text_size(19).font_semibold().child("Herdr Resurrect"))
      .child(div().text_size(12).text_color(t.muted)
        .child("Host-owned snapshots. Restore requires a reviewed preview. No automatic task execution."))
      .child(h_flex().gap(6).children(unique.map((machine, index) =>
        button(`host-${index}`, machine ?? "This computer", !this.busy, cx => {
          this.machine = machine;
          this.preview = null;
          this.reviewed = false;
          this.data = null;
          this.snapshots = [];
          this.report = null;
          this.invoke("status", [], cx);
        }).when(machine === this.machine, element => element.border(1).border_color(t.accent)))))
      .child(div().text_size(13).child(`Selected host: ${this.machine ?? "This computer"}`))
      .child(div().text_size(12).text_color(t.muted)
        .child(`Last snapshot: ${stamp(saved?.at)} · Last capture: ${stamp(health?.capturedAt)}`))
      .child(div().text_size(12).text_color(this.data?.recorderActive ? t.muted : t.blocked)
        .child(this.data?.recorderActive ? "Host recorder is running." : "Host recorder is not confirmed running."))
      .when(Boolean(saved?.unresolved), element => element.child(div().text_size(12).text_color(t.ansi4)
        .child(`${saved.unresolved} saved identities are unresolved or retained from earlier captures.`)))
      .when(Boolean(health?.pending), element => element.child(div().text_size(12).text_color(t.ansi4)
        .child(`Saved work is protected: ${health.pending}. Verify recovery before normal saving resumes.`)))
      .when(Boolean(health?.error || this.error), element => element.child(div().text_size(12).text_color(t.blocked)
        .child(this.error || health.error)))
      .child(h_flex().gap(6)
        .child(button("save", "Save now", !this.busy, cx => this.invoke("capture", [], cx)))
        .child(button("snapshots", "Snapshots", !this.busy, cx => this.invoke("list", [], cx)))
        .child(button("preview", "Preview latest", !this.busy, cx => this.invoke("preview", [], cx)))
        .child(button("verify", "Verify recovery", !this.busy, cx => this.invoke("reconcile", [], cx))))
      .child(v_flex().flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .children(this.snapshots.map((snapshot, index) =>
          button(`snapshot-${index}`, `${stamp(snapshot.at)} · ${snapshot.programs} programs`, !this.busy,
            cx => this.invoke("preview", ["--snapshot", snapshot.name], cx))))
        .when(Boolean(this.preview), element => element
          .child(div().text_size(14).font_semibold().child(`Preview: ${stamp(this.preview.snapshotAt)}`))
          .children((this.preview?.actions || []).map((action, index) => v_flex().gap(3).p(8).rounded(5).bg(t.raised)
            .child(div().text_size(12).child(`${index + 1}. ${action.action} · ${action.pane}`))
            .child(div().text_size(11).text_color(t.muted)
              .child((action.command || []).join(" ") || `Keep terminal ${action.terminal}`))
            .child(div().text_size(11).text_color(t.dim).child(action.cwd || ""))))
          .child(button("reviewed", this.reviewed ? "☑ I reviewed these actions" : "□ I reviewed these actions",
            !this.busy, cx => { this.reviewed = !this.reviewed; cx.notify(); }))
          .child(button("restore", "Restore reviewed actions", this.reviewed && !this.busy, cx => {
            this.invoke("restore", ["--ticket", this.preview.ticket], cx);
          })))
        .when(Boolean(report), element => element.child(div().p(8).text_size(12)
          .child(report?.verified ? "Recovery verified. Normal recording can resume."
            : report?.started !== undefined
              ? `Started ${report.started} programs. Verification is still required.`
              : report?.pending ? `Snapshot remains protected: ${report.pending}`
                : "Snapshot saved."))))
      .when(this.busy, element => element.child(div().text_size(11).text_color(t.dim).child("Working…")));
  }
}
