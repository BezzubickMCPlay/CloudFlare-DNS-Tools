// ==UserScript==
// @name         CloudFlare DNS Tools
// @namespace    http://tampermonkey.net/
// @version      4.5
// @description  Расширение, позволяющее добавлять в Gateway DNS CloudFlare записи из hosts (0.0.0.0 группируется как блокирующие правила) 
// @description  Исправлена работа с новой панелью one.dash.cloudflare.com (удалена зависимость от /gateway/ в URL).
// @author       BezzubickMCPlay (Fork AntiKeks)
// @license      AGPLv3
// @match        https://one.dash.cloudflare.com/*/traffic-policies/*
// @match        https://one.dash.cloudflare.com/*/gateway/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==


(function () {
    'use strict';

    // --- Константы и Утилиты ---
    const isMobile = window.innerWidth <= 768;
    const LIST_ITEM_LIMIT = 1000;
    const AUTO_REFRESH_DELAY = 5;
    const LIST_NAME_PREFIX = '[DNS Tools] AdBlock';
    const API_THROTTLE_MS = 150; // Пауза между API вызовами для стабильности

    const Utils = {
        debugLog: (m, d = null) => console.log(`[CF-DNS-DEBUG ${new Date().toLocaleTimeString()}]`, m, d || ''),
        debugError: (m, e = null) => console.error(`[CF-DNS-ERROR ${new Date().toLocaleTimeString()}]`, m, e || ''),
        parseApiError: (status, responseText) => {
            let msg = `❌ Ошибка API (${status})`;
            try {
                const err = JSON.parse(responseText);
                if (err.errors?.[0]) msg = `❌ ${err.errors[0].message} (код: ${err.errors[0].code})`;
                else if (err.message) msg = `❌ ${err.message}`;
            } catch {
                const match = responseText.match(/<title>(.*?)<\/title>/);
                if (match?.[1]) msg = `❌ ${match[1]}`;
            }
            return msg;
        },
        waitForDOM: () => new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r()),
        smartRefresh: () => location.reload(),
        cleanInputLines: text => text.replace(/<br\s*\/?>/gi, '\n').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\s+.+$/.test(l)),
        deduplicateByDomain: lines => {
            const seen = new Set();
            return lines.filter(line => {
                const domain = line.split(/\s+/)[1]?.toLowerCase();
                if (!domain || seen.has(domain)) return false;
                seen.add(domain);
                return true;
            });
        },
        // Функция для извлечения Account ID из нового URL
        getAccountIdFromUrl: () => {
            // Ищем 32-значный hex код в пути URL (например, /6b66.../)
            const match = window.location.pathname.match(/\/([a-f0-9]{32})(?:\/|$)/i);
            return match ? match[1] : null;
        },
        sendApiRequest: async (url, options) => {
            try {
                const r = await fetch(url, options);
                const text = await r.text();
                if (r.ok) return { success: true, data: text ? JSON.parse(text) : {} };
                Utils.debugError(`Ошибка API (${r.status})`, { url, options, response: text });
                return { success: false, error: Utils.parseApiError(r.status, text) };
            } catch (e) {
                Utils.debugError('Сетевая ошибка', e);
                return { success: false, error: `❌ Сетевая ошибка: ${e.message}` };
            }
        },
        sleep: ms => new Promise(r => setTimeout(r, ms)),
    };

    // --- Менеджер Синхронизации (Ядро) ---
    class SyncManager {
        constructor(accountId, ui) {
            this.accountId = accountId;
            this.ui = ui;
            // API остается на dash.cloudflare.com, даже если UI на one.dash
            this.apiBase = `https://dash.cloudflare.com/api/v4/accounts/${this.accountId}/gateway`;
            this.authOptions = { headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
            this.stats = { listsCreated: 0, rulesCreated: 0, domainsAdded: 0, domainsRemoved: 0, duplicatesRemoved: 0, listsRemoved: 0, rulesRemoved: 0, overridesCreated: 0, overridesUpdated: 0, overridesSkipped: 0 };
        }

        log = (msg) => this.ui.log(msg);
        progress = (p) => this.ui.updateProgress(p);

        async run(sourceDomains, overrideLines) {
            try {
                await this.syncAdBlock(sourceDomains);
                await this.syncOverrides(overrideLines);
                this.logFinalReport();
                this.progress({ stage: 'ЗАВЕРШЕНО', message: 'Все операции успешно выполнены.', current: 1, total: 1 });
                return { success: true, stats: this.stats };
            } catch (e) {
                this.log(`❌ КРИТИЧЕСКАЯ ОШИБКА: ${e.message}`);
                this.progress({ stage: 'ОШИБКА', message: 'Процесс прерван.', current: 1, total: 1 });
                Utils.debugError("Сбой SyncManager", e);
                return { success: false, stats: this.stats };
            }
        }

        async syncAdBlock(sourceDomains) {
            if (sourceDomains.size === 0) {
                this.log('AdBlock домены не найдены, пропускаем синхронизацию.');
                return;
            }
            this.log(`Найдено ${sourceDomains.size} AdBlock доменов.`);

            this.progress({ stage: 'ADBLOCK: АНАЛИЗ', message: 'Получение списков и правил...', current: 1, total: 3 });
            const [listsResp, rulesResp] = await Promise.all([
                Utils.sendApiRequest(`${this.apiBase}/lists`, this.authOptions),
                Utils.sendApiRequest(`${this.apiBase}/rules`, this.authOptions)
            ]);
            if (!listsResp.success) throw new Error(`Не удалось получить списки: ${listsResp.error}`);
            if (!rulesResp.success) throw new Error(`Не удалось получить правила: ${rulesResp.error}`);

            const allRules = rulesResp.data.result || [];
            const managedLists = listsResp.data.result.filter(l => l.name.startsWith(LIST_NAME_PREFIX));
            this.log(`Найдено ${managedLists.length} управляемых списков.`);

            this.progress({ stage: 'ADBLOCK: АНАЛИЗ', message: 'Чтение содержимого списков...', current: 2, total: 3 });
            const domainToLists = new Map();
            for (const list of managedLists) {
                const items = await this._getListItems(list.id);
                items.forEach(item => {
                    if (!domainToLists.has(item)) domainToLists.set(item, []);
                    domainToLists.get(item).push(list.id);
                });
            }
            this.log(`Найдено ${domainToLists.size} уникальных доменов в ${managedLists.length} списках.`);

            this.progress({ stage: 'ADBLOCK: ДЕДУПЛИКАЦИЯ', message: 'Поиск и удаление дубликатов...', current: 0, total: 1 });
            const removalsByList = new Map();
            domainToLists.forEach((listIds, domain) => {
                if (listIds.length > 1) {
                    for (let i = 1; i < listIds.length; i++) {
                        const listIdToRemoveFrom = listIds[i];
                        if (!removalsByList.has(listIdToRemoveFrom)) removalsByList.set(listIdToRemoveFrom, []);
                        removalsByList.get(listIdToRemoveFrom).push(domain);
                        this.stats.duplicatesRemoved++;
                    }
                }
            });

            if (this.stats.duplicatesRemoved > 0) {
                this.log(`Найдено ${this.stats.duplicatesRemoved} дубликатов. Начинаем чистку...`);
                for (const [listId, items] of removalsByList.entries()) {
                    this.log(`Удаление ${items.length} дубликатов из списка ${listId}...`);
                    await Utils.sleep(API_THROTTLE_MS);
                    const res = await Utils.sendApiRequest(`${this.apiBase}/lists/${listId}`, { method: 'PATCH', body: JSON.stringify({ remove: items }), ...this.authOptions });
                    if (!res.success) this.log(`Ошибка при удалении дубликатов: ${res.error}`);
                }
            } else {
                this.log('Дубликаты не найдены.');
            }
            this.progress({ stage: 'ADBLOCK: ДЕДУПЛИКАЦИЯ', message: 'Дедупликация завершена.', current: 1, total: 1 });

            const existingDomains = new Map();
            domainToLists.forEach((listIds, domain) => {
                const primaryListId = listIds.find(id => !removalsByList.has(id)) || listIds[0];
                if (primaryListId) existingDomains.set(domain, primaryListId);
            });
            const domainsToAdd = [...sourceDomains].filter(d => !existingDomains.has(d));
            const domainsToRemove = [...existingDomains.keys()].filter(d => !sourceDomains.has(d));
            this.log(`К добавлению: ${domainsToAdd.length}, к удалению: ${domainsToRemove.length}.`);

            this.progress({ stage: 'ADBLOCK: ОЧИСТКА', message: 'Удаление лишних доменов...', current: 0, total: domainsToRemove.length });
            if (domainsToRemove.length > 0) {
                const removals = new Map();
                domainsToRemove.forEach(d => {
                    const listId = existingDomains.get(d);
                    if (!removals.has(listId)) removals.set(listId, []);
                    removals.get(listId).push(d);
                });
                let processed = 0;
                for (const [listId, items] of removals.entries()) {
                    this.log(`Удаление ${items.length} доменов из списка ${listId}...`);
                    await Utils.sleep(API_THROTTLE_MS);
                    const res = await Utils.sendApiRequest(`${this.apiBase}/lists/${listId}`, { method: 'PATCH', body: JSON.stringify({ remove: items }), ...this.authOptions });
                    if (res.success) this.stats.domainsRemoved += items.length; else this.log(`Ошибка при удалении: ${res.error}`);
                    processed += items.length;
                    this.progress({ stage: 'ADBLOCK: ОЧИСТКА', message: `Удаление доменов...`, current: processed, total: domainsToRemove.length });
                }
            }

            this.log('Поиск и удаление пустых списков...');
            let currentLists = (await Utils.sendApiRequest(`${this.apiBase}/lists`, this.authOptions)).data.result || [];
            for (const list of currentLists.filter(l => l.name.startsWith(LIST_NAME_PREFIX) && l.count === 0)) {
                this.log(`Список ${list.name} пуст. Удаляем...`);
                await Utils.sleep(API_THROTTLE_MS);
                const res = await Utils.sendApiRequest(`${this.apiBase}/lists/${list.id}`, { method: 'DELETE', ...this.authOptions });
                if (res.success) this.stats.listsRemoved++; else this.log(`Ошибка удаления списка: ${res.error}`);
                const rule = allRules.find(r => r.name === list.name || r.traffic.includes(`$${list.id}`));
                if (rule) {
                    await Utils.sleep(API_THROTTLE_MS);
                    const ruleRes = await Utils.sendApiRequest(`${this.apiBase}/rules/${rule.id}`, { method: 'DELETE', credentials: 'include' });
                    if (ruleRes.success) this.stats.rulesRemoved++; else this.log(`Ошибка удаления правила: ${ruleRes.error}`);
                }
            }

            this.progress({ stage: 'ADBLOCK: СОЗДАНИЕ', message: 'Добавление новых доменов...', current: 0, total: domainsToAdd.length });
            if (domainsToAdd.length > 0) {
                let remaining = [...domainsToAdd];
                currentLists = (await Utils.sendApiRequest(`${this.apiBase}/lists`, this.authOptions)).data.result.filter(l => l.name.startsWith(LIST_NAME_PREFIX)) || [];
                let processed = 0;

                this.log('Поиск свободного места в существующих списках...');
                for (const list of currentLists) {
                    if (remaining.length === 0) break;
                    const space = LIST_ITEM_LIMIT - list.count;
                    if (space > 0) {
                        const chunk = remaining.splice(0, space);
                        this.log(`Заполнение существующего списка ${list.name} (${chunk.length} доменов)...`);
                        await Utils.sleep(API_THROTTLE_MS);
                        const patchRes = await Utils.sendApiRequest(`${this.apiBase}/lists/${list.id}`, { method: 'PATCH', body: JSON.stringify({ append: chunk.map(value => ({ value })) }), ...this.authOptions });
                        if (patchRes.success) this.stats.domainsAdded += chunk.length; else this.log(`Ошибка заполнения списка: ${patchRes.error}`);
                        processed += chunk.length;
                        this.progress({ stage: 'ADBLOCK: СОЗДАНИЕ', message: `Заполнение списков...`, current: processed, total: domainsToAdd.length });
                    }
                }

                while (remaining.length > 0) {
                    const listNumbers = currentLists.map(l => parseInt(l.name.split(' ').pop()) || 0);
                    const nextNum = (listNumbers.length > 0 ? Math.max(...listNumbers) : 0) + 1;
                    const newListName = `${LIST_NAME_PREFIX} ${nextNum}`;

                    this.log(`Создание нового списка ${newListName}...`);
                    await Utils.sleep(API_THROTTLE_MS);
                    const createListRes = await Utils.sendApiRequest(`${this.apiBase}/lists`, { method: 'POST', body: JSON.stringify({ name: newListName, type: 'DOMAIN' }), ...this.authOptions });
                    if (!createListRes.success) { this.log(`Ошибка создания списка: ${createListRes.error}`); break; }

                    this.stats.listsCreated++;
                    const newList = createListRes.data.result;
                    currentLists.push(newList);

                    const chunk = remaining.splice(0, LIST_ITEM_LIMIT);
                    this.log(`Добавление ${chunk.length} доменов в ${newListName}...`);
                    await Utils.sleep(API_THROTTLE_MS);
                    const patchRes = await Utils.sendApiRequest(`${this.apiBase}/lists/${newList.id}`, { method: 'PATCH', body: JSON.stringify({ append: chunk.map(value => ({ value })) }), ...this.authOptions });
                    if (patchRes.success) this.stats.domainsAdded += chunk.length; else this.log(`Ошибка добавления доменов: ${patchRes.error}`);

                    const prec = 999999 - nextNum;
                    await Utils.sleep(API_THROTTLE_MS);
                    const createRuleRes = await Utils.sendApiRequest(`${this.apiBase}/rules`, { method: 'POST', body: JSON.stringify({ name: newListName, precedence: prec, action: 'block', traffic: `any(dns.domains[*] in $${newList.id})`, filters: ['dns'], enabled: true }), credentials: 'include' });
                    if (createRuleRes.success) this.stats.rulesCreated++; else this.log(`Ошибка создания правила: ${createRuleRes.error}`);

                    processed += chunk.length;
                    this.progress({ stage: 'ADBLOCK: СОЗДАНИЕ', message: `Создание новых списков...`, current: processed, total: domainsToAdd.length });
                }
            }
        }

        async syncOverrides(overrideLines) {
            if (overrideLines.length === 0) {
                this.log('Override-правила не найдены, пропускаем.');
                return;
            }
            this.log(`Найдено ${overrideLines.length} Override-правил.`);
            this.progress({ stage: 'OVERRIDE: СИНХРОНИЗАЦИЯ', message: 'Обработка правил...', current: 0, total: overrideLines.length });

            const rules = await Utils.sendApiRequest(`${this.apiBase}/rules`, this.authOptions);
            if (!rules.success) throw new Error(`Не удалось получить правила для Override: ${rules.error}`);

            const domainMap = new Map();
            rules.data.result.filter(r => r.name?.includes("→")).forEach(rule => {
                const domainMatch = rule.traffic.match(/==\s*"([^"]+)"/);
                if (domainMatch?.[1] && rule.rule_settings?.override_ips?.[0]) {
                    domainMap.set(domainMatch[1], { id: rule.id, ip: rule.rule_settings.override_ips[0], precedence: rule.precedence });
                }
            });

            const usedPrecSet = new Set(rules.data.result.map(r => r.precedence));
            const getNextPrec = (basePrec) => { let p = basePrec; while(usedPrecSet.has(p)) p++; usedPrecSet.add(p); return p; };

            let processed = 0;
            for (const line of overrideLines) {
                const [ip, domain] = line.split(/\s+/, 2);
                const existing = domainMap.get(domain);
                const rulePayload = { name: `${domain} → ${ip}`, enabled: true, action: "override", filters: ["dns"], traffic: `any(dns.domains[*] == "${domain}")`, rule_settings: { override_ips: [ip] } };

                await Utils.sleep(API_THROTTLE_MS);
                if (existing) {
                    if (existing.ip === ip) {
                        this.stats.overridesSkipped++;
                    } else {
                        this.log(`Обновление правила для ${domain}...`);
                        const res = await Utils.sendApiRequest(`${this.apiBase}/rules/${existing.id}`, { method: 'PUT', body: JSON.stringify({ ...rulePayload, precedence: existing.precedence }), ...this.authOptions });
                        if (res.success) this.stats.overridesUpdated++; else this.log(`Ошибка обновления ${domain}: ${res.error}`);
                    }
                } else {
                    this.log(`Создание правила для ${domain}...`);
                    const res = await Utils.sendApiRequest(`${this.apiBase}/rules`, { method: 'POST', body: JSON.stringify({ ...rulePayload, precedence: getNextPrec(this.ui.precedenceInput.value) }), ...this.authOptions });
                    if (res.success) this.stats.overridesCreated++; else this.log(`Ошибка создания ${domain}: ${res.error}`);
                }
                processed++;
                this.progress({ stage: 'OVERRIDE: СИНХРОНИЗАЦИЯ', message: `Обработка правил...`, current: processed, total: overrideLines.length });
            }
        }

        async _getListItems(listId) {
            const items = new Set();
            const url = `${this.apiBase}/lists/${listId}/items?limit=1000`;
            const res = await Utils.sendApiRequest(url, this.authOptions);
            if (!res.success) throw new Error(`Не удалось прочитать список ${listId}: ${res.error}`);
            res.data.result?.forEach(item => items.add(item.value));
            return items;
        }

        logFinalReport() {
            this.log("--- ИТОГОВЫЙ ОТЧЕТ ---");
            this.log(`Очистка дубликатов: ${this.stats.duplicatesRemoved}`);
            this.log(`Удалено доменов: ${this.stats.domainsRemoved}`);
            this.log(`Добавлено доменов: ${this.stats.domainsAdded}`);
            this.log(`Создано списков/правил: ${this.stats.listsCreated}`);
            this.log(`Удалено списков/правил: ${this.stats.listsRemoved}`);
            this.log(`Override создано/обновлено/пропущено: ${this.stats.overridesCreated}/${this.stats.overridesUpdated}/${this.stats.overridesSkipped}`);
            this.log("----------------------");
        }
    }

    // --- UI и Инициализация ---
    function createMainPanel() {
        const panel = document.createElement('div');
        panel.id = 'cf-dns-tools-main';
        panel.innerHTML = `
            <style>
                :root { --m3-primary: #a4c9ff; --m3-on-primary: #00315c; --m3-primary-container: #004882; --m3-on-primary-container: #d4e3ff; --m3-secondary: #bdc7d8; --m3-on-secondary: #283141; --m3-secondary-container: #3e4758; --m3-surface: #1a1c1e; --m3-surface-container: #262a30; --m3-surface-bright: #36383e; --m3-on-surface: #e2e2e6; --m3-on-surface-variant: #c3c7cf; --m3-outline: #8d9199; --m3-error: #ffb4ab; --m3-on-error: #690005; --m3-error-container: #93000a; }
                #cf-dns-tools-main { position: fixed !important; top: 20px !important; right: 20px !important; width: ${isMobile ? '95vw' : '480px'} !important; max-width: 95vw !important; z-index: 999999 !important; background: var(--m3-surface) !important; border: 1px solid var(--m3-surface-container) !important; border-radius: 28px !important; box-shadow: 0 12px 24px rgba(0,0,0,0.3) !important; color: var(--m3-on-surface) !important; font-family: 'Roboto', 'Noto Sans', sans-serif !important; }
                .cf-panel-header { padding: 16px 24px !important; font-weight: 600 !important; display: flex !important; justify-content: space-between !important; align-items: center !important; cursor: pointer !important; user-select: none !important; color: var(--m3-primary) !important; font-size: 18px !important; }
                .cf-panel-header #toggle-btn { transition: transform 0.3s ease; }
                #cf-panel-content { padding: 16px 24px !important; display: block !important; border-top: 1px solid var(--m3-outline); }
                .cf-grid { display: grid !important; grid-template-columns: 1fr; gap: 12px !important; margin-bottom: 20px !important; }
                .cf-grid button { border-radius: 20px !important; font-weight: 500 !important; padding: 10px 24px !important; transition: background-color 0.3s ease, opacity 0.3s ease; display: flex; align-items: center; justify-content: center; gap: 8px; border:none; cursor:pointer; }
                button.sync { background: var(--m3-primary) !important; color: var(--m3-on-primary) !important; }
                button.delete { background: var(--m3-error-container) !important; color: var(--m3-on-error-container) !important; }
                .settings-box { background: var(--m3-surface-container) !important; padding: 16px !important; border-radius: 16px !important; margin-bottom: 20px; }
                #hosts-input { background: var(--m3-surface-container) !important; color: var(--m3-on-surface-variant) !important; border: 1px solid var(--m3-outline) !important; border-radius: 16px !important; width: 100%; box-sizing: border-box; padding: 12px; height: 140px; }
                #hosts-input:focus { border-color: var(--m3-primary) !important; outline: 2px solid var(--m3-primary) !important; outline-offset: 2px; }
                #status-area { padding: 12px; background: var(--m3-surface-container); border-radius: 16px; font-family: 'Roboto Mono', monospace; }
                #progress-view { margin-bottom: 8px; }
                #progress-stage { font-weight: bold; color: var(--m3-primary); }
                #progress-message { font-size: 12px; color: var(--m3-on-surface-variant); }
                .progress-bar { width: 100%; background-color: var(--m3-surface-bright); border-radius: 4px; overflow: hidden; height: 8px; margin: 8px 0; }
                .progress-bar-inner { height: 100%; width: 0; background-color: var(--m3-primary); transition: width 0.3s ease-out; }
                #log-view { max-height: 150px; overflow-y: auto; font-size: 12px; color: var(--m3-on-surface-variant); padding-top: 8px; border-top: 1px solid var(--m3-surface-bright); }
                #log-view p { margin: 0 0 4px; }
                #copy-log-btn { margin-top: 10px; padding: 6px 12px !important; border-radius: 12px !important; background: var(--m3-secondary-container) !important; color: var(--m3-on-surface) !important; border: none; cursor: pointer; }
            </style>
            <div class="cf-panel-header">🛠️ CloudFlare DNS Tools <span id="toggle-btn">▼</span></div>
            <div id="cf-panel-content">
                <div class="cf-grid">
                    <button class="sync" id="sync-btn"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg> Синхронизировать</button>
                    <button class="delete" id="delete-btn"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg> Удалить все</button>
                </div>
                <div class="settings-box">
                    <div style="display: flex; align-items: center; gap: 8px;"><label for="precedence-input">Precedence для Override:</label><input type="number" value="10000" min="1" id="precedence-input" style="width: 80px; padding: 4px 8px;"></div>
                    <div style="display: flex; align-items: center; gap: 8px;"><input type="checkbox" id="log-checkbox"><label for="log-checkbox">Debug режим (не перезагружать)</label></div>
                </div>
                <textarea id="hosts-input" placeholder="Вставьте hosts записи сюда..."></textarea>
                <div id="status-area">
                    <div id="progress-view">
                        <div id="progress-stage">Готов к работе...</div>
                        <div class="progress-bar"><div id="progress-bar-inner" style="width: 0%;"></div></div>
                        <div id="progress-message">Ожидание команды</div>
                    </div>
                    <div id="log-view"></div>
                    <button id="copy-log-btn">📋 Копировать лог</button>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        return panel;
    }

    async function main() {
        await Utils.waitForDOM();
        await Utils.sleep(2000);
        const panel = createMainPanel();

        const ui = {
            content: panel.querySelector('#cf-panel-content'),
            toggleBtn: panel.querySelector('#toggle-btn'),
            syncBtn: panel.querySelector('#sync-btn'),
            deleteBtn: panel.querySelector('#delete-btn'),
            logCheckbox: panel.querySelector('#log-checkbox'),
            hostsInput: panel.querySelector('#hosts-input'),
            precedenceInput: panel.querySelector('#precedence-input'),
            progress: {
                stage: panel.querySelector('#progress-stage'),
                bar: panel.querySelector('#progress-bar-inner'),
                message: panel.querySelector('#progress-message'),
            },
            logView: panel.querySelector('#log-view'),
            copyLogBtn: panel.querySelector('#copy-log-btn'),
            log: (message) => {
                ui.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
                const p = document.createElement('p');
                p.textContent = message;
                ui.logView.appendChild(p);
                ui.logView.scrollTop = ui.logView.scrollHeight;
            },
            updateProgress: (p) => {
                ui.progress.stage.textContent = `ЭТАП: ${p.stage}`;
                ui.progress.message.textContent = p.message;
                const percent = p.total > 0 ? (p.current / p.total) * 100 : 0;
                ui.progress.bar.style.width = `${percent}%`;
            },
            reset: () => {
                ui.logs = [];
                ui.logView.innerHTML = '';
                ui.updateProgress({ stage: 'Готов', message: 'Ожидание команды', current: 0, total: 1 });
            },
            setRunning: (running) => {
                ui.isRunning = running;
                ui.syncBtn.disabled = running;
                ui.deleteBtn.disabled = running;
                ui.syncBtn.style.opacity = running ? 0.6 : 1;
                ui.deleteBtn.style.opacity = running ? 0.6 : 1;
            },
            logs: [],
            isRunning: false,
        };

        ui.toggleBtn.parentElement.addEventListener('click', () => {
            const isCollapsed = ui.content.style.display === 'none';
            ui.content.style.display = isCollapsed ? 'block' : 'none';
            ui.toggleBtn.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(180deg)';
        });

        ui.copyLogBtn.addEventListener('click', () => navigator.clipboard.writeText(ui.logs.join('\n')));

        ui.deleteBtn.addEventListener('click', async () => {
            if (ui.isRunning) return;
            if (!confirm(`🗑️ ВНИМАНИЕ!\n\nЭто действие удалит ВСЕ правила и списки, созданные скриптом (с префиксом "${LIST_NAME_PREFIX}"), а также все индивидуальные правила перезаписи.\n\nПродолжить?`)) return;

            ui.setRunning(true);
            ui.reset();
            ui.log('Начинаем полное удаление...');

            // --- ИСПРАВЛЕНИЕ: Универсальный поиск ID ---
            const accountId = Utils.getAccountIdFromUrl();
            if (!accountId) { ui.log('❌ Ошибка: не найден account_id в URL.'); ui.setRunning(false); return; }

            const apiBase = `https://dash.cloudflare.com/api/v4/accounts/${accountId}/gateway`;
            const authOptions = { credentials: 'include' };

            const rules = (await Utils.sendApiRequest(`${apiBase}/rules`, authOptions)).data?.result || [];
            const lists = (await Utils.sendApiRequest(`${apiBase}/lists`, authOptions)).data?.result || [];

            const rulesToDelete = rules.filter(r => r.name && (r.name.startsWith(LIST_NAME_PREFIX) || r.name.includes('→')));
            const listsToDelete = lists.filter(l => l.name && l.name.startsWith(LIST_NAME_PREFIX));

            for (const item of [...rulesToDelete, ...listsToDelete]) {
                const type = item.traffic ? 'rules' : 'lists';
                ui.log(`Удаление ${type === 'rules' ? 'правила' : 'списка'}: ${item.name}`);
                await Utils.sleep(API_THROTTLE_MS);
                await Utils.sendApiRequest(`${apiBase}/${type}/${item.id}`, { method: 'DELETE', ...authOptions });
            }

            ui.log(`✅ Удаление завершено. Перезагрузка через ${AUTO_REFRESH_DELAY} сек...`);
            setTimeout(Utils.smartRefresh, AUTO_REFRESH_DELAY * 1000);
        });

        ui.syncBtn.addEventListener('click', async () => {
            if (ui.isRunning) return;
            const lines = Utils.deduplicateByDomain(Utils.cleanInputLines(ui.hostsInput.value));
            if (lines.length === 0) { alert("Нет валидных строк для импорта!"); return; }

            // --- ИСПРАВЛЕНИЕ: Универсальный поиск ID ---
            const accountId = Utils.getAccountIdFromUrl();
            if (!accountId) { alert("Ошибка: не найден account_id в URL."); return; }

            ui.setRunning(true);
            ui.reset();

            const blockDomains = new Set(lines.filter(l => l.startsWith('0.0.0.0 ')).map(l => l.split(/\s+/)[1].trim()));
            const overrideLines = lines.filter(l => !l.startsWith('0.0.0.0 '));

            const manager = new SyncManager(accountId, ui);
            const result = await manager.run(blockDomains, overrideLines);

            if (result.success && !ui.logCheckbox.checked) {
                ui.log(`Перезагрузка через ${AUTO_REFRESH_DELAY} секунд...`);
                setTimeout(Utils.smartRefresh, AUTO_REFRESH_DELAY * 1000);
            }
            ui.setRunning(false);
        });

        Utils.debugLog('✅ CloudFlare DNS Tools v4.5 успешно загружены!');
    }

    main().catch(e => Utils.debugError('❌ Критическая ошибка инициализации:', e));
})();
