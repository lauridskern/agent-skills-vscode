export function getSkillsSidebarScript(): string {
  return `
        const vscode = acquireVsCodeApi();
        let state = initialState || {};
        let activePanel = state.activePanel || 'installed';
        let searchTimeout = null;
        let scrollRaf = null;

        const installedList = document.getElementById('installed-list');
        const marketplaceList = document.getElementById('marketplace-list');
        const searchInput = document.getElementById('search');
        const installedPanel = document.getElementById('installed-panel');
        const marketplacePanel = document.getElementById('marketplace-panel');

        const persistedState = vscode.getState() || {};
        const scrollState = {
            installed: state.scroll?.installed ?? persistedState.scroll?.installed ?? 0,
            marketplace: state.scroll?.marketplace ?? persistedState.scroll?.marketplace ?? 0
        };
        let localSearchQuery = persistedState.search?.query ?? state.searchQuery ?? '';
        let installed = state.installedSkills || [];
        let marketplace = state.marketplaceSkills || [];
        let isLoading = Boolean(state.isLoadingMarketplace);
        let isLoadingMore = Boolean(state.isLoadingMore);
        let hasMore = Boolean(state.hasMore);
        let loadError = state.marketplaceError || null;

        searchInput.value = localSearchQuery;

        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === activePanel));
        document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));

        function esc(str) {
            const d = document.createElement('div');
            d.textContent = str != null ? String(str) : '';
            return d.innerHTML;
        }

        function formatInstalls(num) {
            if (typeof num !== 'number') return String(num);
            if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
            if (num >= 1000) return (num / 1000).toFixed(1).replace(/\\.0$/, '') + 'K';
            return String(num);
        }

        function groupBy(arr, keyFn) {
            return arr.reduce((acc, item) => {
                const key = keyFn(item);
                (acc[key] = acc[key] || []).push(item);
                return acc;
            }, {});
        }

        function renderInstalled() {
            let items = installed;
            if (localSearchQuery) {
                const q = localSearchQuery.toLowerCase();
                items = items.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
            }

            if (items.length === 0) {
                installedList.innerHTML = '<div class="empty-state">' + 
                    (localSearchQuery ? 'No matching skills found.' : 'No skills installed.<br><br>Switch to Browse to discover and install skills.') + 
                '</div>';
                return;
            }

            const grouped = groupBy(items, s => s.level + '|' + s.mode);
            const order = [
                'project|universal',
                'project|cursor',
                'project|claude',
                'project|codex',
                'project|gemini',
                'project|opencode',
                'project|agent',
                'user|universal',
                'user|cursor',
                'user|claude',
                'user|codex',
                'user|gemini',
                'user|opencode',
                'user|agent'
            ];
            const labels = {
                'project|universal': 'Project / Shared (Codex, Gemini, OpenCode)',
                'project|cursor': 'Project / Cursor',
                'project|claude': 'Project / Claude', 
                'project|codex': 'Project / Codex',
                'project|gemini': 'Project / Gemini CLI',
                'project|opencode': 'Project / OpenCode',
                'project|agent': 'Project / Antigravity',
                'user|universal': 'User / Shared (Codex, Gemini, OpenCode)',
                'user|cursor': 'User / Cursor',
                'user|claude': 'User / Claude',
                'user|codex': 'User / Codex',
                'user|gemini': 'User / Gemini CLI',
                'user|opencode': 'User / OpenCode',
                'user|agent': 'User / Antigravity'
            };

            let html = '';
            order.forEach(key => {
                const skills = grouped[key];
                if (!skills || skills.length === 0) return;

                html += '<div class="list-header" data-group="' + key + '">' +
                    '<span class="arrow codicon codicon-chevron-down"></span>' +
                    '<span>' + labels[key] + '</span>' +
                    '<span class="badge">' + skills.length + '</span>' +
                '</div>';
                html += '<div class="list-content">';
                skills.forEach(s => {
                    const updatedDate = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString('de-DE') : '';
                    let description = esc(s.description || 'No description');
                    if (s.updateAvailable) {
                        description += ' · Update available';
                    }
                    // Match by marketplace id, or fallback to name if no id and no ambiguity
                    const marketplaceMatch = s.marketplaceId 
                        ? marketplace.find(m => m.id === s.marketplaceId)
                        : marketplace.filter(m => m.name === s.name).length === 1 
                            ? marketplace.find(m => m.name === s.name) 
                            : null;
                    html += '<div class="list-item" tabindex="0" data-path="' + esc(s.path) + '">' +
                        '<div class="item-content">' +
                            '<div class="item-title title-link" data-path="' + esc(s.path) + '">' + esc(s.name) + '</div>' +
                            '<div class="item-subtitle">' + description + '</div>' +
                        '</div>' +
                        '<div class="item-actions">' +
                            (updatedDate ? '<span class="item-meta-top"><span class="codicon codicon-history"></span>' + esc(updatedDate) + '</span>' : '<span></span>') +
                            '<div class="item-buttons">' +
                                (marketplaceMatch ? '<button class="reinstall-btn install-btn" data-repo="' + esc(marketplaceMatch.source) + '" data-skill="' + esc(s.name) + '">Reinstall</button>' : '') +
                                '<button class="remove-btn delete-btn" data-path="' + esc(s.path) + '" data-name="' + esc(s.name) + '" data-level="' + esc(s.level) + '" data-mode="' + esc(s.mode) + '">Remove</button>' +
                            '</div>' +
                        '</div>' +
                    '</div>';
                });
                html += '</div>';
            });

            installedList.innerHTML = html;
        }

        function renderMarketplace() {
            if (isLoading && marketplace.length === 0) {
                marketplaceList.innerHTML = '<div class="loading">Loading skills...</div>';
                return;
            }

            if (loadError && marketplace.length === 0) {
                marketplaceList.innerHTML = '<div class="empty-state">' + esc(loadError) + '<br><br><a href="#" class="retry-link">Try again</a></div>';
                const retryLink = marketplaceList.querySelector('.retry-link');
                if (retryLink) {
                    retryLink.addEventListener('click', (e) => {
                        e.preventDefault();
                        vscode.postMessage({command: 'refresh'});
                    });
                }
                return;
            }

            const items = marketplace;

            if (items.length === 0) {
                marketplaceList.innerHTML = '<div class="empty-state">' + 
                    (localSearchQuery ? 'No matching skills found.' : 'No skills available.') + 
                '</div>';
                return;
            }

            // Build a set of installed marketplace ids for fast lookup
            const installedIds = new Set(installed.map(s => s.marketplaceId).filter(Boolean));
            // Also track installed names for fallback when no marketplaceId
            const installedNames = new Set(installed.filter(s => !s.marketplaceId).map(s => s.name));

            // Count marketplace skills by name to detect duplicates (for fallback matching)
            const marketplaceNameCount = new Map();
            items.forEach(s => {
                marketplaceNameCount.set(s.name, (marketplaceNameCount.get(s.name) || 0) + 1);
            });

            let html = '<div class="marketplace-disclaimer">Data provided by <a href="#" class="disclaimer-link" data-url="https://skills.sh">skills.sh</a>, an open directory by Vercel</div>';
            items.forEach(s => {
                // Match by marketplace id, or fallback to name if no id and no ambiguity
                const hasIdMatch = installedIds.has(s.id);
                const hasFallbackMatch = installedNames.has(s.name) && marketplaceNameCount.get(s.name) === 1;
                const isInstalled = hasIdMatch || hasFallbackMatch;
                const rowClass = isInstalled ? 'list-item installed-gradient' : 'list-item';
                const btnClass = isInstalled ? 'reinstall-btn install-btn' : 'primary install-btn';
                const btnLabel = isInstalled ? 'Reinstall' : 'Install';
                const skillUrl = 'https://skills.sh/' + esc(s.source) + '/' + esc(s.name);
                html += '<div class="' + rowClass + '" tabindex="0">' +
                    '<div class="item-content">' +
                        '<div class="item-title title-link" data-url="' + esc(skillUrl) + '">' + esc(s.name) + '</div>' +
                        '<div class="item-subtitle">' + esc(s.source) + '</div>' +
                    '</div>' +
                    '<div class="item-actions">' +
                        '<span class="item-meta-top">' +
                            '<span class="codicon codicon-cloud-download"></span>' +
                            '<span>' + formatInstalls(s.installs) + '</span>' +
                        '</span>' +
                        '<button class="' + btnClass + '" data-repo="' + esc(s.source) + '" data-skill="' + esc(s.name) + '">' + btnLabel + '</button>' +
                    '</div>' +
                '</div>';
            });

            if (hasMore) {
                html += '<div id="load-more-trigger" class="loading" style="padding: 12px;">' + 
                    (isLoadingMore ? 'Loading more...' : '') + 
                '</div>';
            }

            marketplaceList.innerHTML = html;
            setupInfiniteScroll();
        }

        function setupInfiniteScroll() {
            const trigger = document.getElementById('load-more-trigger');
            if (!trigger || !hasMore) return;

            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting && hasMore && !isLoadingMore && !isLoading) {
                        vscode.postMessage({ command: 'loadMore' });
                    }
                });
            }, { threshold: 0.1 });

            observer.observe(trigger);
        }

        function persistState(next) {
            const current = vscode.getState() || {};
            vscode.setState({ ...current, ...next });
        }

        function applyState(nextState) {
            if (!nextState) return;
            state = nextState;
            installed = state.installedSkills || [];
            marketplace = state.marketplaceSkills || [];
            isLoading = Boolean(state.isLoadingMarketplace);
            isLoadingMore = Boolean(state.isLoadingMore);
            hasMore = Boolean(state.hasMore);
            loadError = state.marketplaceError || null;
            activePanel = state.activePanel || activePanel;
            const isFocused = document.activeElement === searchInput;
            if (!isFocused) {
                localSearchQuery = state.searchQuery ?? localSearchQuery;
                searchInput.value = localSearchQuery;
                const current = vscode.getState() || {};
                persistState({ search: { ...(current.search || {}), query: localSearchQuery } });
            }
            document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.panel === activePanel));
            document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));
        }

        function render() {
            if (activePanel === 'installed') renderInstalled();
            else renderMarketplace();
            requestAnimationFrame(() => {
                if (activePanel === 'installed' && installedPanel) {
                    installedPanel.scrollTop = scrollState.installed || 0;
                } else if (activePanel === 'marketplace' && marketplacePanel) {
                    marketplacePanel.scrollTop = scrollState.marketplace || 0;
                }
            });
        }

        searchInput.addEventListener('input', e => {
            localSearchQuery = e.target.value;
            const current = vscode.getState() || {};
            persistState({ search: { ...(current.search || {}), query: localSearchQuery } });
            
            if (activePanel === 'installed') {
                render();
            } else {
                scrollState.marketplace = 0;
                if (marketplacePanel) {
                    marketplacePanel.scrollTop = 0;
                }
                if (searchTimeout) clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    vscode.postMessage({ command: 'search', query: localSearchQuery });
                }, 150);
            }
        });

        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                activePanel = tab.dataset.panel;
                document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
                document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === activePanel + '-panel'));
                vscode.postMessage({ command: 'setActivePanel', panel: activePanel });
                render();
            });
        });

        function scheduleScrollReport(panelKey, top) {
            scrollState[panelKey] = top;
            if (scrollRaf) return;
            scrollRaf = requestAnimationFrame(() => {
                scrollRaf = null;
                persistState({ scroll: scrollState, activePanel });
                vscode.postMessage({ command: 'panelScroll', panel: panelKey, scrollTop: scrollState[panelKey] });
            });
        }

        if (installedPanel) {
            installedPanel.addEventListener('scroll', () => {
                scheduleScrollReport('installed', installedPanel.scrollTop);
            });
        }

        if (marketplacePanel) {
            marketplacePanel.addEventListener('scroll', () => {
                scheduleScrollReport('marketplace', marketplacePanel.scrollTop);
            });
        }

        document.addEventListener('click', e => {
            if (e.target.closest('.list-header')) {
                e.target.closest('.list-header').classList.toggle('collapsed');
                return;
            }

            const titleLink = e.target.closest('.title-link');
            if (titleLink) {
                if (titleLink.dataset.path) {
                    vscode.postMessage({ command: 'openSkill', path: titleLink.dataset.path });
                } else if (titleLink.dataset.url) {
                    vscode.postMessage({ command: 'openUrl', url: titleLink.dataset.url });
                }
                return;
            }

            const disclaimerLink = e.target.closest('.disclaimer-link');
            if (disclaimerLink) {
                e.preventDefault();
                vscode.postMessage({ command: 'openUrl', url: disclaimerLink.dataset.url });
                return;
            }
            
            const installBtn = e.target.closest('.install-btn');
            if (installBtn) {
                vscode.postMessage({ command: 'install', repo: installBtn.dataset.repo, skill: installBtn.dataset.skill });
                return;
            }

            const deleteBtn = e.target.closest('.delete-btn');
            if (deleteBtn) {
                vscode.postMessage({
                    command: 'deleteSkill',
                    path: deleteBtn.dataset.path,
                    name: deleteBtn.dataset.name,
                    level: deleteBtn.dataset.level,
                    mode: deleteBtn.dataset.mode
                });
                return;
            }
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message?.command === 'state') {
                applyState(message.state);
                render();
            }
        });

        vscode.postMessage({ command: 'webviewReady' });
        render();
`;
}
