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
            background: transparent;
        }

        body {
            padding: 0;
            color: var(--vscode-foreground);
            font-size: var(--vscode-font-size);
            font-weight: var(--vscode-font-weight);
            font-family: var(--vscode-font-family);
        }

        .content {
            background: var(--vscode-sideBar-background);
            min-height: 100vh;
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
        }

        .panel.active {
            display: block;
            overflow: auto;
            max-height: calc(100vh - 90px);
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
            height: 50px;
            padding: 10px 10px;
            padding-right: 150px;
            cursor: pointer;
            align-items: flex-start;
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

        .item-subtitle {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
            line-height: 1.3;
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
            top: 0;
            z-index: 5;
            padding: 8px 10px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background: var(--vscode-sideBar-background);
            border-bottom: 1px solid var(--vscode-widget-border);
        }

        .marketplace-disclaimer a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .marketplace-disclaimer a:hover {
            text-decoration: underline;
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
