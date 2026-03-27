import * as vscode from "vscode";
import { WebviewState } from "../skillsSidebarState";
import { getSkillsSidebarScript } from "./skillsSidebarController";

export function buildSkillsSidebarHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
  initialState: WebviewState,
): string {
  const codiconsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(
      extensionUri,
      "node_modules",
      "@vscode/codicons",
      "dist",
      "codicon.css",
    ),
  );

  const initialStateJson = JSON.stringify(initialState);
  const script = getSkillsSidebarScript();

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link href="${codiconsUri}" rel="stylesheet" />
    <title>Agent Skills</title>
    <style>
        :root {
            --container-padding: 0;
            --input-padding-vertical: 6px;
            --input-padding-horizontal: 8px;
        }
        
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        html, body {
            height: 100%;
            background: transparent;
        }

        body {
            padding: 0;
            overflow: hidden;
            color: var(--vscode-foreground);
            font-size: var(--vscode-font-size);
            font-weight: var(--vscode-font-weight);
            font-family: var(--vscode-font-family);
        }

        .content {
            display: flex;
            flex-direction: column;
            background: var(--vscode-sideBar-background);
            height: 100vh;
            width: calc(100% - 1px);
            margin-right: 1px;
        }

        input, button {
            font-family: inherit;
            font-size: inherit;
        }

        input {
            display: block;
            width: 100%;
            padding: var(--input-padding-vertical) var(--input-padding-horizontal);
            color: var(--vscode-input-foreground);
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-input-border, transparent);
            border-radius: 2px;
        }

        input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: -1px;
        }

        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        button {
            border: none;
            padding: var(--input-padding-vertical) var(--input-padding-horizontal);
            text-align: center;
            cursor: pointer;
            border-radius: 2px;
        }

        button.primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        button.primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }

        .header {
            position: sticky;
            top: 0;
            z-index: 10;
            background: var(--vscode-sideBar-background);
        }

        .search-box {
            padding: 8px 8px 4px 8px;
        }

        .tabs {
            display: flex;
            padding: 0 8px;
            gap: 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            background: var(--vscode-sideBar-background);
        }

        .tab {
            flex: 1;
            padding: 8px 12px;
            background: none;
            border: none;
            border-bottom: 2px solid transparent;
            color: var(--vscode-foreground);
            opacity: 0.7;
            cursor: pointer;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .tab:hover {
            opacity: 1;
        }

        .tab.active {
            opacity: 1;
            border-bottom-color: var(--vscode-panelTitle-activeBorder, var(--vscode-focusBorder));
        }

        .panel {
            display: none;
            min-height: 0;
        }

        .panel.active {
            display: block;
            flex: 1 1 auto;
            overflow: auto;
            min-height: 0;
        }

        #marketplace-list {
            min-height: 100%;
            display: flex;
            flex-direction: column;
        }

        #marketplace-list > * {
            flex: 0 0 auto;
        }

        .list-header {
            display: flex;
            align-items: center;
            padding: 6px 12px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-weight: 700;
            color: var(--vscode-sideBarSectionHeader-foreground);
            background: var(--vscode-sideBarSectionHeader-background);
            cursor: pointer;
            user-select: none;
        }

        .list-header:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .list-header .arrow {
            font-size: 12px;
            margin-right: 4px;
            transition: transform 0.15s;
            -webkit-text-stroke: 0.5px currentColor;
        }

        .list-header.collapsed .arrow {
            transform: rotate(-90deg);
        }

        .list-header .badge {
            margin-left: auto;
            padding: 2px 6px;
            border-radius: 10px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            font-size: 10px;
            font-weight: normal;
        }

        .list-content {
            overflow: hidden;
        }

        .list-header.collapsed + .list-content {
            display: none;
        }

        .list-item {
            position: relative;
            display: flex;
            min-height: 58px;
            padding: 10px 10px;
            padding-right: 150px;
            cursor: pointer;
            align-items: flex-start;
        }

        .marketplace-item {
            min-height: 54px;
            padding-right: 10px;
        }

        .list-item:hover {
            background: var(--vscode-list-hoverBackground);
        }

        .list-item:focus {
            background: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
            outline: none;
        }

        .item-content {
            flex: 1;
            min-width: 0;
            overflow: hidden;
        }

        .item-title {
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.3;
            cursor: pointer;
        }

        .item-title:hover {
            text-decoration: underline;
        }

        .item-title-row {
            display: flex;
            align-items: center;
            gap: 3px;
            min-width: 0;
        }

        .item-title-main {
            display: flex;
            align-items: center;
            gap: 3px;
            min-width: 0;
            flex: 1 1 auto;
        }

        .official-check {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 14px;
            height: 14px;
            color: var(--vscode-textLink-foreground);
            flex: 0 0 auto;
        }

        .official-check svg {
            width: 14px;
            height: 14px;
            display: block;
        }

        .item-subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
            line-height: 1.3;
            flex: 1 1 auto;
            min-width: 0;
        }

        .item-subtitle-row {
            display: flex;
            align-items: center;
            column-gap: 7px;
            flex-wrap: nowrap;
            min-width: 0;
        }

        .item-subtitle-spacer {
            flex: 1 1 auto;
            min-width: 0;
        }

        .item-tags {
            display: inline-flex;
            align-items: center;
            flex-wrap: nowrap;
            gap: 6px;
            min-width: max-content;
            flex: 0 0 auto;
            margin-top: 2px;
        }

        .title-tags {
            margin-top: 0;
        }

        .audit-badge {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            height: 14px;
            padding: 0;
            font-size: 8px;
            font-weight: 600;
            letter-spacing: 0.04em;
            line-height: 14px;
            white-space: nowrap;
            color: var(--vscode-descriptionForeground);
        }

        .audit-bars {
            display: inline-flex;
            align-items: flex-end;
            gap: 1px;
            height: 8px;
        }

        .audit-bars span {
            display: block;
            width: 2px;
            background: currentColor;
            opacity: 0.3;
        }

        .audit-bars span:nth-child(1) {
            height: 8px;
        }

        .audit-bars span:nth-child(2) {
            height: 8px;
        }

        .audit-bars span:nth-child(3) {
            height: 8px;
        }

        .audit-label {
            display: inline-block;
            transform: translateY(0.5px);
        }

        .audit-badge.audit-good {
            color: var(--vscode-debugIcon-startForeground, var(--vscode-terminal-ansiGreen));
        }

        .audit-badge.audit-warn {
            color: var(--vscode-testing-iconQueued, var(--vscode-terminal-ansiYellow));
        }

        .audit-badge.audit-bad {
            color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
        }

        .audit-badge.audit-neutral {
            color: var(--vscode-descriptionForeground);
        }

        .audit-badge[data-level="1"] .audit-bars span:nth-child(1),
        .audit-badge[data-level="2"] .audit-bars span:nth-child(-n+2),
        .audit-badge[data-level="3"] .audit-bars span:nth-child(-n+3) {
            opacity: 1;
        }

        .item-actions {
            position: absolute;
            right: 10px;
            top: 8px;
            bottom: 8px;
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            justify-content: space-between;
        }

        .item-meta-top {
            font-size: 10px;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            display: inline-flex;
            align-items: center;
            gap: 3px;
        }

        .item-meta-top .codicon {
            font-size: 12px;
        }

        .item-meta-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .marketplace-item .item-title-row .item-meta-group {
            margin-left: auto;
            flex: 0 0 auto;
        }

        .marketplace-item .item-subtitle-row {
            margin-top: 2px;
            margin-bottom: 0;
        }

        .marketplace-item .item-subtitle {
            margin-top: 0;
            flex: 0 1 auto;
        }

        .marketplace-item .item-subtitle-row .item-tags {
            margin-top: 1px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 140ms ease-out;
        }

        .marketplace-item .install-btn {
            margin-left: auto;
            flex: 0 0 auto;
        }

        .marketplace-item:hover .item-subtitle-row .item-tags,
        .marketplace-item:focus .item-subtitle-row .item-tags,
        .marketplace-item:focus-within .item-subtitle-row .item-tags {
            opacity: 1;
        }

        .item-meta-pill {
            font-size: 10px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            padding: 1px 5px;
            border-radius: 999px;
            background: rgba(127, 127, 127, 0.12);
        }

        .install-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
        }

        .remove-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
            background: rgba(255, 255, 255, 0.15);
            border: none;
            color: var(--vscode-foreground);
        }

        .remove-btn:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .reinstall-btn {
            height: 16px;
            padding: 0 5px;
            font-size: 11px;
            font-weight: 500;
            border-radius: 2px;
            line-height: 16px;
            background: rgba(255, 255, 255, 0.15);
            border: none;
            color: var(--vscode-foreground);
        }

        .reinstall-btn:hover {
            background: rgba(255, 255, 255, 0.25);
        }

        .item-buttons {
            display: flex;
            gap: 4px;
            padding-top: 2px;
        }

        .list-item.installed-gradient {
            background: linear-gradient(90deg, transparent 0%, rgba(135, 161, 191, 0.08) 100%);
        }

        .list-item.installed-gradient:hover {
            background: linear-gradient(90deg, var(--vscode-list-hoverBackground) 0%, rgba(135, 161, 191, 0.15) 100%);
        }

        .empty-state {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .empty-state a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }

        .empty-state a:hover {
            text-decoration: underline;
        }

        .marketplace-disclaimer {
            position: sticky;
            bottom: 0;
            z-index: 5;
            display: flex;
            align-items: center;
            margin-top: auto;
            padding: 2px 10px;
            font-size: 11px;
            line-height: 1.3;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-top: 1px solid var(--vscode-panel-border);
        }

        .marketplace-disclaimer a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .marketplace-disclaimer a:hover {
            text-decoration: underline;
        }

        .marketplace-toolbar {
            position: sticky;
            top: 0;
            z-index: 4;
            padding: 8px 10px 10px;
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .feed-selector {
            display: flex;
            flex-wrap: nowrap;
            gap: 6px;
        }

        .feed-btn {
            flex: 1 1 0;
            padding: 3px 8px;
            border: 1px solid transparent;
            background: rgba(127, 127, 127, 0.12);
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
            line-height: 1.2;
            text-align: center;
        }

        .feed-btn:hover {
            background: rgba(127, 127, 127, 0.2);
            color: var(--vscode-foreground);
        }

        .feed-btn.active {
            background: rgba(72, 141, 255, 0.14);
            border-color: rgba(72, 141, 255, 0.45);
            color: var(--vscode-foreground);
        }

        .marketplace-hint {
            margin-top: 8px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            line-height: 1.35;
        }

        .loading {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }

    </style>
</head>
<body>
    <div class="content">
    <div class="header">
        <div class="search-box">
            <input type="text" id="search" placeholder="Search skills...">
        </div>

        <div class="tabs">
            <button class="tab active" data-panel="installed">Installed</button>
            <button class="tab" data-panel="marketplace">Browse</button>
        </div>
    </div>

        <div class="panel active" id="installed-panel">
            <div id="installed-list"></div>
        </div>

        <div class="panel" id="marketplace-panel">
            <div id="marketplace-list"></div>
        </div>
    </div>

    <script nonce="${nonce}">
        const initialState = ${initialStateJson};
${script}
    </script>
</body>
</html>`;
}
