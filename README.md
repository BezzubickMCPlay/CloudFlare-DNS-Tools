# CloudFlare DNS Tools

Этот userscript для Tampermonkey/Greasemonkey представляет собой мощный инструмент для управления DNS-политиками в **Cloudflare Gateway**. Он был создан для решения основной проблемы: невозможности удобно управлять большими списками блокировки (100,000+ доменов) через стандартный интерфейс Cloudflare.

Скрипт добавляет удобную панель управления прямо на страницу Cloudflare Gateway, позволяя вам синхронизировать огромные списки доменов в формате `hosts` всего одной кнопкой.

### История и благодарности

Этот скрипт является глубокой переработкой и развитием идей, заложенных в оригинальном скрипте от автора **AntiKeks**. Огромная благодарность ему за первоначальную работу, которая послужила основой для этого проекта.

## Установка

**[>> Установить скрипт <<](https://raw.githubusercontent.com/BezzubickMCPlay/CloudFlare-DNS-Tools/main/CloudFlare-DNS-Tools.user.js)**

*(Для установки требуется менеджер пользовательских скриптов, например, [Tampermonkey](https://www.tampermonkey.net/))*

## Ключевые возможности

*   **Работа с огромными списками:** Легко обрабатывает списки из сотен тысяч доменов, не замораживая браузер.
*   **Обход лимита в 1000 доменов:** Автоматически разделяет ваш большой список на множество мелких (по 1000 доменов в каждом), обходя жесткое ограничение Cloudflare.
*   **Умная синхронизация:** Скрипт не просто удаляет и создает все заново. Он анализирует текущее состояние и вносит только необходимые изменения: добавляет новые домены и удаляет те, которых больше нет в вашем списке.
*   **Дедупликация:** Перед синхронизацией скрипт автоматически находит и удаляет дубликаты доменов, которые могли оказаться в разных списках из-за сбоев, поддерживая систему в чистоте.
*   **Эффективное заполнение:** Скрипт сначала пытается заполнить свободное место в уже существующих списках и только потом создает новые. Это минимизирует количество списков и правил в вашем аккаунте.
*   **Поддержка двух режимов:**
    *   **Блокировка (AdBlock):** Строки вида `0.0.0.0 example.com` добавляются в списки блокировки.
    *   **Перезапись (Override):** Строки вида `1.2.3.4 my-service.local` создают индивидуальные DNS-правила для перезаписи IP-адреса.
*   **Полная очистка:** Кнопка "Удалить все" позволяет одним кликом полностью удалить все списки и правила, созданные скриптом, чтобы начать с чистого листа.

## Как это работает ("Магия")

Представьте, что Cloudflare дает вам книжную полку, но на каждую полку можно поставить не более 1000 книг. Если у вас 110,000 книг, вы не можете просто вывалить их все на одну полку.

Скрипт работает как умный библиотекарь:
1.  Он видит ваши 110,000 "книг" (доменов).
2.  Он смотрит на вашу "книжную полку" (Cloudflare) и видит, что там уже есть, например, 110 полок, на каждой из которых лежит по 1000 книг.
3.  **Анализ:** Он быстро сверяет, какие книги у вас есть, а каких нет на полках, и наоборот.
4.  **Очистка:** Если он находит лишние книги на полках, он их убирает. Если какая-то полка становится пустой, он убирает и саму полку.
5.  **Заполнение:** Затем он берет новые книги и начинает расставлять их на полки, где есть свободное место.
6.  **Создание:** Только когда на всех старых полках не остается места, он ставит новую полку (`[DNS Tools] AdBlock 111`) и начинает заполнять ее.

Для каждой "полки" (списка) он также вешает табличку-инструкцию (`DNS-правило`), которая гласит: "Все, что на этой полке, — блокировать".

## Как использовать

1.  Перейдите в вашу панель **Cloudflare Zero Trust**.
2.  В меню слева выберите **Gateway** -> **DNS Policies**. Путь в адресной строке должен выглядеть так: `https://one.dash.cloudflare.com/ACCOUNT_ID/gateway/policies/dns`.
3.  Справа вверху появится панель **CloudFlare DNS Tools**.
4.  Подготовьте ваш список доменов в формате `hosts`. Например:
    ```
    # Блокировка рекламы
    0.0.0.0 ads.example.com
    0.0.0.0 analytics.tracker.net

    # Локальные сервисы
    192.168.1.100 nas.local
    192.168.1.101 server.local
    ```
5.  Вставьте этот текст в текстовое поле в панели скрипта.
6.  Нажмите кнопку **Синхронизировать**.
7.  Следите за процессом в окне статуса. Скрипт покажет все этапы: анализ, очистку, создание и финальный отчет.
8.  После завершения синхронизации страница автоматически перезагрузится (если не включен Debug-режим).

## Где найти списки и правила

Чтобы вручную посмотреть, что создал скрипт, вы можете найти его компоненты здесь:

*   **Списки доменов:**
    *   `Zero Trust` -> `Gateway` -> `Lists`
    *   Здесь вы увидите списки с именами `[DNS Tools] AdBlock 1`, `[DNS Tools] AdBlock 2` и т.д.

*   **Правила блокировки:**
    *   `Zero Trust` -> `Gateway` -> `Firewall Policies` -> `DNS`
    *   Здесь вы увидите правила с такими же именами, которые используют эти списки.

## Лицензия

Этот проект распространяется под лицензией AGPLv3.

---
---

# English Version

## CloudFlare DNS Tools

This userscript for Tampermonkey/Greasemonkey is a powerful tool for managing DNS policies within **Cloudflare Gateway**. It was created to solve a core problem: the inability to conveniently manage large blocklists (100,000+ domains) through the standard Cloudflare interface.

The script adds a user-friendly control panel directly onto the Cloudflare Gateway page, allowing you to synchronize massive `hosts`-formatted domain lists with a single click.

### History & Acknowledgements

This script is a deep refactoring and evolution of the ideas laid out in the original script by the author **AntiKeks**. Huge thanks to him for the initial work that served as the foundation for this project.

## Installation

**[>> Install Script <<](https://raw.githubusercontent.com/BezzubickMCPlay/CloudFlare-DNS-Tools/main/CloudFlare-DNS-Tools.user.js)**

*(Requires a userscript manager like [Tampermonkey](https://www.tampermonkey.net/))*

## Key Features

*   **Handles Huge Lists:** Easily processes lists with hundreds of thousands of domains without freezing your browser.
*   **Bypasses the 1000-Domain Limit:** Automatically splits your large list into many smaller ones (1000 domains each), working around Cloudflare's hard limit.
*   **Smart Synchronization:** The script doesn't just delete and recreate everything. It analyzes the current state and only makes the necessary changes: adding new domains and removing those no longer in your list.
*   **Deduplication:** Before syncing, the script automatically finds and removes duplicate domains that might exist across multiple lists due to past failures, keeping your configuration clean.
*   **Efficient Filling:** The script first tries to fill any available space in existing lists before creating new ones. This minimizes the number of lists and rules in your account.
*   **Dual-Mode Support:**
    *   **Blocking (AdBlock):** Lines like `0.0.0.0 ads.example.com` are added to blocklists.
    *   **Overriding:** Lines like `1.2.3.4 my-service.local` create individual DNS rules to override the IP address.
*   **Complete Cleanup:** The "Delete All" button allows you to completely remove all lists and rules created by the script with one click, letting you start from a clean slate.

## How It Works (The Magic)

Imagine Cloudflare gives you a bookshelf, but you can only place a maximum of 1000 books on each shelf. If you have 110,000 books, you can't just dump them all on one shelf.

The script acts like a smart librarian:
1.  It sees your 110,000 "books" (domains).
2.  It looks at your "bookshelf" (Cloudflare) and sees what's already there, for example, 110 shelves, each with 1000 books.
3.  **Analysis:** It quickly checks which books you have that aren't on the shelves, and vice-versa.
4.  **Cleanup:** If it finds extra books on the shelves, it removes them. If a shelf becomes empty, it removes the shelf itself.
5.  **Filling:** It then takes the new books and starts placing them on shelves where there is free space.
6.  **Creation:** Only when all existing shelves are full does it add a new shelf (`[DNS Tools] AdBlock 111`) and start filling it.

For each "shelf" (list), it also hangs an instruction sign (`DNS Rule`) that says, "Block everything on this shelf."

## How to Use

1.  Navigate to your **Cloudflare Zero Trust** dashboard.
2.  In the left-hand menu, select **Gateway** -> **DNS Policies**. The URL path should look like `https://one.dash.cloudflare.com/ACCOUNT_ID/gateway/policies/dns`.
3.  The **CloudFlare DNS Tools** panel will appear in the top-right corner.
4.  Prepare your list of domains in `hosts` format. For example:
    ```
    # Block ads
    0.0.0.0 ads.example.com
    0.0.0.0 analytics.tracker.net

    # Local services
    192.168.1.100 nas.local
    192.168.1.101 server.local
    ```
5.  Paste this text into the textarea in the script's panel.
6.  Click the **Synchronize** button.
7.  Monitor the process in the status window. The script will show all stages: analysis, cleanup, creation, and a final report.
8.  After synchronization is complete, the page will automatically reload (unless Debug mode is enabled).

## Where to Find the Lists & Rules

To manually see what the script has created, you can find its components here:

*   **Domain Lists:**
    *   `Zero Trust` -> `Gateway` -> `Lists`
    *   Here you will see lists named `[DNS Tools] AdBlock 1`, `[DNS Tools] AdBlock 2`, etc.

*   **Blocking Rules:**
    *   `Zero Trust` -> `Gateway` -> `Firewall Policies` -> `DNS`
    *   Here you will see rules with the same names that use these lists.

## License

This project is licensed under the AGPLv3 License.
