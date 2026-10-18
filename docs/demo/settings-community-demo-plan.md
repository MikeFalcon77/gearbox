# План реализации Gearbox Community Demo

## Цель и обязательные решения

Подготовить воспроизводимое community-демо Gearbox и gears-rust с готовым продуктом: **Open product → Deploy → Open UI → показать работающие gears и сгенерированный продукт в IDE**.

Прикладное приложение — Settings Service. Продукт заранее скомпонован и настроен. Ручное добавление gears и создание продукта через AI-chat не входят в обязательный сценарий.

- Все приложения Gears, frontend и вспомогательный echo backend работают в minikube.
- Event Broker использует существующий SQLite backend. Platform metadata DB EB и отдельный event log находятся на одном постоянном volume, в разных файлах.
- Для этого Gearbox получает поддержку выбора SQLite platform DB для отдельного gear. Текущий generator platform DB поддерживает только Postgres; SQLite runtime в Toolkit уже существует.
- Settings и Postgres Cluster используют внешний Docker Postgres с постоянным data volume. Postgres не разворачивается в Kubernetes.
- Используются Toolkit contracts, OAGW, Event Broker, Cluster primitives, Service Discovery и входящий API Gateway.
- Общий профессиональный UI содержит четыре gear-модуля: Settings, Event Broker, Discovery и Types Registry V1.
- Фотографии Даши и Ильи и семейная сцена с мороженым обязательны.
- Все пользовательские надписи, ошибки UI и presentation runbook — на английском. Сам план написан по-русски для передачи агенту.
- Живой атаки на tenant isolation не будет. Автоматические отрицательные проверки изоляции обязательны.
- Сроки и дата выступления не являются входными данными плана. Переход между фазами определяется результатами проверки.
- Полная готовность подтверждается репетицией на презентационном Mac.

## Готовая конфигурация Firebase для агента

**Подготовительный этап Firebase уже завершён. Повторно создавать проект, Web App или выполнять первоначальную настройку Google provider не требуется.**

Готовый проект: `gearbox-community-demo-b0d222`.

Готовый Web App: `1:187822417640:web:6588a97b364605d1484b5d`.

Firebase CLI уже был авторизован. Google sign-in включён; OAuth client настроен; среди authorized domains присутствуют `localhost`, `gearbox-community-demo-b0d222.firebaseapp.com` и `gearbox-community-demo-b0d222.web.app`.

Оба реальных аккаунта прошли Google sign-in на `http://localhost:4173`. Проверены подпись Firebase ID token, issuer/audience, временные claims, verified email и Google provider. Отдельно подтверждены Firebase user records и разные UID для двух лабораторий.

Готовые локальные файлы находятся в каталоге:

```text
C:\projects\gearbox\.gearbox\firebase-preflight\
```

Агенту нужно прочитать:

1. **`C:\projects\gearbox\.gearbox\firebase-preflight\authn-demo-inputs.json`** — основной handoff: project ID, Web App ID, issuer/audience и проверенное соответствие tenant → Google email → Firebase UID.
2. **`C:\projects\gearbox\.gearbox\firebase-preflight\firebase-web-config.json`** — готовая public Firebase Web SDK configuration для frontend.
3. **`C:\projects\gearbox\.gearbox\firebase-preflight\state.json`** — статус `firebase-ready`, результаты cloud configuration checks и подтверждение обоих входов.
4. **`C:\projects\gearbox\.gearbox\firebase-preflight\signins.json`** — evidence двух реальных входов с UID, provider и результатом проверки подписи.
5. **`C:\projects\gearbox\.gearbox\firebase-preflight\expected-users.json`** — согласованные аккаунты для Dasha's Lab и Ilya's Lab.

Дополнительно в этом каталоге лежат `firebase.json`, helpers `configure.cjs`, `finalize.cjs`, `server.cjs`, локальная страница `index.html` и screenshot `verified.png`. Helpers служат для обслуживания и воспроизведения preflight; их не нужно запускать как обычный шаг реализации или Deploy.

Все эти файлы находятся вне git под ignored `.gearbox`. Личные email и UID читать из handoff, не дублировать в tracked templates. User tokens, refresh tokens и пароли checker не сохранял. Готовые UID и public SDK config не являются credential для входа от имени пользователей.

На другом checkout, worktree или Mac `.gearbox` автоматически не появится. Перед началом работы перенести перечисленные локальные JSON-конфиги отдельным приватным способом и проверить их согласованность. Если файлов нет, восстановить handoff из исходного checkout; не создавать другой Firebase project вместо существующего.

Основной product UI планируется открывать на `http://localhost:8080`. Порт `4173` относится к отдельному readiness checker. При переносе на Mac проверить обычный пользовательский Google login в целевом браузере; новую первоначальную cloud-настройку Firebase это не заменяет и не требует.

## Состояние перед реализацией

- Firebase cloud setup и проверка двух аккаунтов завершены.
- Gearbox branch `codex/settings-community-demo` уже создана при сохранении этого плана от `feature/gdl-extensible`, исходный HEAD `6d60603f8db36ef30ee50e1ff7008f3ee24a2501`.
- Gears-rust находится на `feature/gearbox`, исходный HEAD `b90bea456f0894dc703cf7e9b546397e8fcda215`. Demo-ветку там ещё нужно создать.
- Продукт, Kubernetes runtime, SQLite override, UI SDK и Deploy по этому плану ещё не реализованы. Факт готовности Firebase не означает готовность AuthN adapter внутри gears-rust.

## Фаза 0 Новые ветки и рабочий baseline

### Ветки и сохранение исходных исправлений

- В `C:\projects\gearbox` работать в `codex/settings-community-demo`, созданной от `feature/gdl-extensible`. Перед продолжением проверить текущую ветку и её происхождение; существующую demo-ветку не пересоздавать.
- В `C:\projects\gears-rust-mikefalcon77` создать `codex/settings-community-demo` от текущей `feature/gearbox`.
- Перед любыми изменениями проверить branch, HEAD и рабочее дерево обоих репозиториев. Сохранить все исправления feature-веток, незакоммиченные изменения и необходимые untracked files.
- Ветки не создавать от main. Не делать reset/clean и не перезаписывать пользовательскую работу.
- Реализацию вести небольшими commits в новых ветках. Push не выполнять.

### Технический baseline

- Исправить переносимость генераторных тестов: Linux-путь `/workspace/...` не должен ломать работу с корпусом на Windows.
- Для обязательных corpus-тестов отсутствие gears-rust должно завершаться ошибкой, а не успешным пропуском. Указывать corpus root явно и сохранять результаты.
- Заменить генерируемый `docker build --ignorefile` на Dockerfile-specific ignore files.
- Проверить Docker build context с реальными local source roots, dependency closure и сгенерированными Cargo manifests.
- Локальные roots должны ссылаться на checkout с нужными feature/demo-исправлениями. Конфигурация путей должна переноситься между Windows и Mac без hardcode Windows-путей в Linux containers.
- Зафиксировать revisions, команды проверки и результаты в execution notes demo-продукта.

**Условие завершения:** обязательные generator/database проверки проходят на настоящем корпусе gears-rust; сгенерированный backend действительно собирается в Docker.

## Фаза 1 Подготовленный продукт и постоянное хранилище в Kubernetes

### Компоновка продукта

Создать `products/settings-community-demo` с готовыми GDL composition, deployment profile, конфигурацией и bootstrap recipes.

- **`demo-gateway`**: входящий `api-gateway`, EB в standalone-режиме, Service Discovery, grpc-hub, Types Registry V1, OAGW, Cluster, AuthN/AuthZ и обязательные зависимости.
- **`demo-settings-worker`**: Settings Service, локальный Types Registry V1 и остальные обязательные зависимости.
- **`demo-ui`**: общий frontend под nginx.
- **Echo workload**: небольшой HTTP backend для демонстрации OAGW.

`demo-gateway` — имя приложения. Gear `api-gateway` принимает входящие HTTP-запросы и размещает REST routes EB и других gears. Gear `oagw` отвечает за исходящие запросы. EB не размещается внутри OAGW.

Все четыре демонстрируемых backend gear работают в Kubernetes. Отдельный Deployment на каждый gear не требуется: несколько gears могут входить в одно приложение. Полный dependency closure определяет resolver; обязательные зависимости не удалять ради упрощения схемы.

### Per-gear SQLite platform DB

- Сохранить существующую конфигурацию внешнего Postgres и добавить явный SQLite override для platform DB конкретного gear.
- Override применяется только к указанному gear; Postgres server fields в него не наследуются.
- В resolved IR/lock хранить фактически выбранный backend и SQLite path.
- Согласованно обновить GDL evaluation/validation, IR, lock serialization, TypeScript types, diagnostics, generator и документацию.
- Генерировать корректный Toolkit database config и необходимые Cargo features.
- SQLite gear исключать из Postgres provisioning и генерации PostgreSQL database names.
- Отсутствующая или противоречивая конфигурация должна давать ошибку до deployment.
- Сохранить совместимость существующих Postgres-only продуктов.

Для EB задать отдельные файлы platform metadata DB и event log внутри одного persistent mount, например `eb/metadata.sqlite3` и `eb/events.sqlite3` относительно согласованного runtime home directory. Проверить фактические абсолютные paths внутри container и соответствующий mount.

Metadata DB включает specifications, producers, consumer groups, cursors и broker outbox. SQLite event-storage plugin хранит сам event log. Обе части должны реально использовать файловое хранилище на PVC.

Существующие migrations EB выполнить на настоящем SQLite. Новый Postgres event backend и перенос metadata EB на Postgres не разрабатывать.

### PVC и lifecycle EB

- Создать StorageClass `gearbox-demo-retain` с `reclaimPolicy: Retain`, используя provisioner целевого minikube; стандартный StorageClass кластера не изменять.
- Создать стабильный PVC `gearbox-demo-gateway-data` в namespace `gearbox-demo`.
- Проверить `Bound` и фактический `Retain` у созданного PV.
- Монтировать каталог целиком, включая SQLite WAL/SHM files.
- Явно задать файловые SQLite paths. Для данных EB исключить `:memory:`, `emptyDir` и container filesystem.
- Обычный Deploy использует существующий PVC, не удаляет и не пересоздаёт его.
- Для приложения с EB: одна реплика, без autoscaling, `strategy: Recreate`. При обновлении Deploy ожидает завершения старого экземпляра.
- Не запускать отдельный SQLite migration Job параллельно с работающим Gateway. Использовать startup DB phase до открытия traffic.
- Не включать удаление PVC, namespace или minikube profile в обычные deploy/reset операции.

### Deployment assets и сеть

- Проверить существующие `./deploy` conventions, включая пример mini-chat, и добавить недостающие Docker/Helm assets для independently deployable приложений.
- Product umbrella chart разворачивает весь состав. Gear внутри общего процесса покрывается чартом этого приложения.
- Генерировать Kubernetes Service addresses, Directory endpoint, advertised endpoints и внутреннюю аутентификацию.
- Исключить loopback fallback для Directory между pod'ами.
- Для remote contracts использовать существующий static endpoint resolver с адресами Kubernetes Services. Не представлять его как native Kubernetes discovery и не скрывать GBX0603.
- Отдельно проверить регистрацию worker в Directory и proxy routing через API Gateway.
- Настроить migrations, startup/readiness probes, writable directories и startup dependencies.

### Внешний Docker Postgres

- Использовать внешний Docker Postgres с постоянным data volume. Сейчас среда пользователя использует WSL; для Mac подготовить эквивалентную Docker-конфигурацию.
- Выделить demo-БД и credentials для Settings и Cluster, не затрагивая посторонние данные.
- Передавать credentials через Secrets.
- Адрес задавать отдельно для WSL и Mac; доступность проверять из pod'ов.
- Postgres Deployment/StatefulSet в product chart не добавлять.

**Условие завершения:** сгенерированный продукт запускается в minikube; Gateway видит worker; EB полностью работает на SQLite и переживает пересоздание pod и повторный Deploy; Settings и Cluster подключаются к внешнему Postgres.

## Фаза 2 Интеграция готового Firebase и bootstrap

### Firebase AuthN plugin

- Прочитать готовые `authn-demo-inputs.json`, `firebase-web-config.json` и `state.json` из локального handoff.
- Использовать Firebase verifier и AuthN adapter из `C:\projects\boring-pills\crates\boring-auth` как исходную базу.
- Разместить самостоятельный Firebase AuthN plugin в gears-rust, добавить GDL и сохранить attribution.
- Убрать привязки к boring-pills: project, allowlist, общий tenant, namespace/type identity и требование ровно двух accounts.
- Project ID, UID/email mappings и identity configuration брать из deployment config. Для этого продукта использовать уже созданный Firebase project и уже проверенные UID.
- Реальные identities сопоставлять по Firebase UID; verified email использовать как дополнительную проверку allowlist.
- Подключать plugin через gears-rust source root Gearbox. Boring-pills служит источником реализации, отдельный nonstop session SDK в demo не нужен.
- Проверить RS256 signature, issuer/audience, expiry, неизвестный kid, неверный project, неподходящий account и key-fetch outage.

Tenant hierarchy: `Family` — root; `Dasha's Lab` и `Ilya's Lab` — sibling tenants. Backend определяет tenant и privileges; browser configuration не является источником полномочий.

### Техническая аутентификация

AuthN resolver выбирает один plugin. Автоматическую цепочку Firebase + static-authn не предполагать.

- Для demo реализовать явный AuthN adapter: пользовательские tokens делегируются Firebase verifier, технические credentials — существующей ограниченной `static_tokens`/S2S реализации.
- Adapter явно выбирает реализацию проверки; vendor/priority не должны случайно переключать тип аутентификации.
- Неизвестные credentials отклонять; `accept_all` не использовать.
- Технические credentials генерировать при подготовке, хранить в Secrets, не включать во frontend или logs.
- Platform-plane credentials Directory/worker проверять отдельно от tenant-plane аутентификации EB и Settings.

### Авторизация и bootstrap

- Сохранить tenant hierarchy checks через tr-authz и добавить явный demo policy layer для разрешённых действий и operator diagnostics.
- Worker может публиковать только демонстрационные topics/types и только для разрешённых tenants.
- Diagnostic access к Discovery/Types не даёт автоматически доступа к settings или событиям соседнего tenant.
- Защитить backend endpoints независимо от видимости UI navigation.
- Подготовить идемпотентный bootstrap через Toolkit SDK с отдельной bootstrap identity. Не использовать raw SQL inserts, публичный bootstrap endpoint или отключённую авторизацию.
- Создать декларации настроек, topics/event types и начальные значения.
- GTS declarations и V1 registrations восстанавливать при запуске каждого соответствующего процесса: V1 registry хранится в памяти.
- Повторный Deploy не сбрасывает overrides. Reset demo values — отдельная явная операция через сервисные API, ограниченная demo-данными.
- Демонстрационные настройки — non-secret, без step-up.

**Условие завершения:** основной backend принимает реальные tokens настроенного проекта и технические credentials; оба пользователя попадают в нужные tenants; автоматические проверки запрещают cross-tenant чтение, запись и подписку. Повторного Firebase setup для выполнения этой фазы не требуется.

## Фаза 3 Реальная цепочка contracts и событий до полноценного UI

### Remote Settings contract

- Добавить новый минимальный `SettingsReadApi v1`: effective read и bulk effective read, используя существующие domain types и DTO.
- Добавить REST projection и GDL provides/consumes.
- Backend adapter в Gateway обслуживает effective-settings widget через remote contract Settings worker.
- Существующие локальные Settings SDK сохранить совместимыми. Remote secrets/contributions в demo contract не добавлять.
- Проверить реальный вызов между приложениями с нужным user/tenant context.

### Settings → outbox → удалённый EB

- Использовать существующие toolkit-db outbox и `ProducerOutbox`, не писать новый outbox framework.
- Setting mutation, audit и enqueue записываются в одной транзакции.
- `Wake::fire` вызывать только после commit; rollback не создаёт опубликованного события.
- Relay подключить к существующему `RestBroker`.
- Передавать настоящую bearer credential через transport. EB должен авторизовать worker для tenant события, включая `TENANT_SCOPE_RESOURCE`.
- Transient errors приводят к retry; committed изменение не должно терять событие при недоступном EB.
- Проверить восстановление после рестарта worker и EB.

### Cluster primitives

- Подключить Postgres Cluster provider и использовать существующий EB cache/notification path.
- Исправить `wait_for_notification`: при ошибке watch выдерживать оставшийся timeout.
- При отсутствии native prefix watch использовать существующий bounded polling fallback.
- Исключить busy loop и поток повторяющихся warnings при ошибках backend.
- Логами или счётчиками подтвердить реальное использование cache markers и notification/recheck path.
- Polling fallback описывать честно. Новую инвалидацию Settings через exact watch только ради презентации не добавлять.

### OAGW

- Подготовить авторизованный вызов echo workload через OAGW.
- Разрешить HTTP upstream только в demo profile и точный внутренний hostname в SSRF policy.
- Возвращать в UI ответ, request/correlation ID и upstream.
- Браузер не обращается к echo напрямую.

### Ранний вертикальный прогон

До UI SDK сделать минимальную временную browser-страницу на настоящих API: изменить настройку Dasha, получить событие во второй вкладке Dasha, перечитать effective value и проверить неизменность Ilya. Эта страница проверяет backend; готовый Firebase readiness checker для этого не подменяет продуктовые API.

**Условие завершения:** работает реальная цепочка Settings worker → transactional outbox → удалённый EB → браузер; подтверждены remote Settings contract, Cluster path и OAGW request.

## Фаза 4 Общий UI SDK и расширение GDL

Стек boring-pills: React 19, TypeScript, Vite, Tailwind 4, TanStack Query, lucide и Firebase Web SDK. Для frontend использовать готовую public SDK configuration из handoff.

- Создать `@gears/ui-sdk`, `@gears/product-shell` и отдельные UI packages gears.
- Зафиксировать `GearUiPlugin v1` с экспортом `plugin` и contributions для pages, navigation и widgets.
- Shell отвечает за login, текущего пользователя и tenant, API client, query lifecycle, navigation, theme, notifications и error boundaries.
- Query keys и browser state разделять по identity/tenant. При logout или смене identity очищать соответствующие caches и subscriptions.
- Композицию выполнять при сборке, страницы загружать лениво. Runtime module federation не добавлять.
- Добавить необязательные UI declarations у gear: UI package и backend requirements. У product — shell и явный список модулей.
- npm identity/version/exports брать из package.json; Rust resolver не исполняет JavaScript.
- Согласованно обновить validation, IR, lock, TypeScript types, diagnostics, version handling и документацию. Сохранить совместимость продуктов без UI declarations.
- Генерировать frontend workspace, module registry, runtime config, nginx, Dockerfile и Helm resources.

**Условие завершения:** подготовленный GDL генерирует и собирает shell с Settings-модулем; отсутствующие или несовместимые UI dependencies диагностируются до deployment.

## Фаза 5 Четыре UI модуля и семейная сцена

### Settings

- String/bool/number values и validation.
- Effective values и inheritance indicators.
- History, ETag/If-Match и понятное разрешение конфликтов.
- OAGW echo action.
- Widget, обновляющийся после реального события EB и повторного чтения Settings.

### Event Broker inspector

- Live stream, event ID/type/tenant/time, JSON и фильтр.
- Состояние соединения и автоматическое восстановление.
- Независимая subscription/group для каждой вкладки.
- Fetch-based streaming с bearer, обновлением credentials при reconnect и обработкой настоящих stream/control frames.
- Использовать фактические server routes; не предполагать наличие отдельного REST ACK/commit.

После успешной обработки сохранять клиентский checkpoint отдельно для каждого topic/partition. Изолировать checkpoint по пользователю, tenant, stream и вкладке. После reconnect выполнять JOIN/SEEK по сохранённым позициям. Дубликаты отсеивать по event ID. При недоступной из-за retention позиции показывать понятное состояние.

Browser checkpoint не называть транзакционно committed cursor бизнес-потребителя. Новый ACK endpoint ради inspector не разрабатывать. Дедупликация и восстановление соединения обязательны; расширенное администрирование consumer groups и ручной pause/resume в основной объём не входят.

### Discovery

Read-only UI показывает gears, версии, capabilities/dependencies, compiled/OOP distinction, instances/endpoints, состояния, refresh и время последнего обновления. Register/deregister через UI не добавлять.

### Types Registry V1

Read-only UI показывает schemas/instances, list/filter, GTS IDs и JSON с явным выбором источника Gateway или Settings. Для worker использовать allowlisted read adapter через Gateway. Не изображать единый глобальный registry и не переходить на V2.

### nginx и SSE

- Для streaming location отключить proxy buffering и caching.
- Read timeout согласовать с heartbeat; Authorization не должен теряться.
- Upstream должен корректно отдавать `X-Accel-Buffering: no`; одной установки заголовка в конечный browser response недостаточно для управления upstream buffering.
- Smoke check проходит по полному пути browser → nginx → Gateway → EB. Проверить поступление событий без ожидания завершения response.

### Профессиональное оформление

Использовать визуальный язык https://constructorfabric.org/: Geist и Geist Mono, navy/blue palette, светлый фон, аккуратные cards, forms, tables и JSON viewer. Базовые tokens: navy `#00204D`, primary `#0065E3`, background `#F2F6FC`, text `#0E1A2C`, border `#DCE3EE`.

Шрифты и assets поставлять локально, без CDN-зависимости. Проверить loading/empty/error states, keyboard navigation и responsive layout. Все пользовательские надписи — на английском.

### Фотографии и обязательный фан

Исходные фото:

- `C:\Users\Mike\Downloads\dasha_fresh.JPEG`.
- `C:\Users\Mike\Downloads\ilya_fresh.JPEG`.

Использовать именно обновлённые фотографии. Создать отдельные copies, применить EXIF orientation, удалить EXIF/GPS/прочие metadata и проверить результат визуально. Originals сохранить. Обработанные фотографии включать только в private ignored demo bundle; на Mac переносить отдельно. Не помещать их в git или публичные templates.

Фотографии, подписи и tenant presentation задаются конфигурацией продукта, а не hardcode внутри gears:

- Dasha's Lab — фото Даши и подпись **Chief Ice Cream Officer**.
- Ilya's Lab — фото Ильи и подпись **Head of Quality Assurance**.

Настройка **Ice cream approved** — non-secret boolean, default false, с валидной GTS declaration и английской label.

Сценарий:

1. Открыты две вкладки Dasha и независимый browser context Ilya, с реальными accounts из handoff.
2. У Dasha меняем настройку на true.
3. В EB inspector появляется событие.
4. Вторая вкладка Dasha получает событие и перечитывает effective value.
5. Показывает **Approved. Deploy the ice cream. 🍦** и небольшое confetti.
6. У Ilya остаётся **Still waiting for approval.**

Confetti запускается только после подтверждённого события и успешного перечитывания. Первичная загрузка и replay старых событий не запускают его повторно. Учесть dedup и reduced motion.

Настоящий signed-in пользователь показывается отдельно от персонажа лаборатории. Для доказательства EB отключить polling/focus refetch демонстрационного widget. На split screen показать карточку Dasha и соответствующее событие с тем же event ID в inspector.

**Условие завершения:** все четыре UI-модуля работают на настоящем backend; семейная сцена проходит в независимых browser contexts без подмены событий локальными timers.

## Фаза 6 Подготовка на Mac и Deploy из Gearbox

### Команда подготовки

Реализовать одну команду: preflight → resolve/generate → Docker build → minikube image load → persistent infrastructure → migrations/bootstrap → deployment → smoke checks.

Preflight проверяет Docker, minikube, kubectl, Helm, архитектуру images, CPU/RAM/disk Docker/minikube, внешний Postgres из pod, Google/Firebase connectivity из браузера и pod, Secrets, готовый Firebase handoff, обработанные фото, SQLite paths, writable mount, PVC binding и PV reclaim policy.

Использовать Docker build cache mounts. Холодные сборки выполнить до презентации. Подготовка не создаёт новый Firebase project/Web App, не запускает Firebase login и не требует management credentials для обычного product Deploy.

### Проверенный bundle

Сохранять product lock, manifests, точные image references, product/source revisions и dirty-input digest, версии UI/generator и non-secret configuration, результат подготовки и smoke checks. Учитывать изменяемые path dependencies, а не только product.lock.

При missing/stale bundle показывать конкретную причину и требование повторной подготовки. Секреты и пользовательские tokens не включать в bundle или logs. Полноценная универсальная система fingerprints не требуется.

### Deploy в Gearbox

Кнопка запускает подготовленный deployment script и показывает streaming progress: validate → persistent infrastructure → migrations/bootstrap → Helm upgrade/install → readiness → Open UI.

- Использовать готовые images, сохранять PVC и данные.
- Не запускать скрытую холодную сборку при stale bundle.
- Потеря RPC response не запускает вторую deployment operation автоматически.
- Открывать UI через управляемый localhost port-forward на порту 8080; показывать состояние потери соединения и поддержать восстановление.
- Ограничить операции profile и namespace `gearbox-demo`.
- Не включать удаление namespace/PVC/minikube profile в обычный deploy flow.

**Условие завершения:** пользователь открывает готовый продукт, нажимает Deploy и получает рабочий UI без ручной настройки gears, редактирования manifests или сборки контейнеров.

## Фаза 7 Приёмка и полная репетиция

### Обязательные проверки

- Реальный Google login в продукте с обоими уже проверенными accounts и техническая аутентификация.
- Автоматические cross-tenant запреты для settings, events и subscriptions; недоступность diagnostics без operator permission.
- Настоящий remote Settings contract и OAGW echo с правильной policy.
- Outbox: commit, rollback, retry, недоступность EB и восстановление после рестарта.
- Cluster fallback без busy loop и потока warnings.
- Fetch stream reconnect, JOIN/SEEK и dedup; SSE без буферизации через nginx; отсутствие повторного confetti при replay.
- Сохранность SQLite events и metadata после аварийного завершения процесса, пересоздания pod и повторного Deploy.
- Восстановление browser inspector по клиентскому checkpoint; не подменять эту проверку тестом TxCommitHandle Rust-потребителя.
- Сохранность данных после minikube stop/start на целевом Mac.
- Восстановление V1 registrations при startup.
- Playwright для основного сценария и визуальная проверка четырёх модулей.
- Понятные ошибки missing Secret, stale bundle, login, readiness и stream reconnect.

### Backup и restore

- Перед backup остановить приложение-писатель EB и сохранить согласованную копию metadata DB и event log.
- Не копировать только основной db file у работающего WAL writer.
- Для полного восстановления продукта подготовить согласованный snapshot остальных demo-данных и конфигурации, включая выделенные Settings DB во внешнем Postgres. На время общего snapshot остановить writers.
- Сохранить отдельно private assets и Firebase handoff. Проверить restore в контролируемом прогоне.
- В runbook явно записать: pod replacement и повторный Deploy сохраняют PVC; stop/start проверен; после minikube delete среду восстанавливаем из backup независимо от Retain; PVC не является резервной копией от потери всей среды или диска.

### Сценарий выступления

1. Открыть подготовленный продукт в Gearbox и показать состав.
2. Нажать Deploy, дождаться readiness и открыть UI.
3. Показать Settings и две лаборатории с фотографиями.
4. Выполнить сцену с мороженым рядом с EB inspector.
5. Показать, что состояние Ilya не изменилось.
6. Открыть Discovery.
7. Открыть Types V1 с явным источником Gateway/Settings.
8. Выполнить OAGW echo.
9. Показать в IDE GDL и сгенерированный продукт.

Cluster показать через реальную конфигурацию и диагностику использования EB; отдельный искусственный сценический эпизод не нужен.

Живую атаку на изоляцию не проводить. Безопасность подтверждается результатами автоматической приёмки. Удаление pod на сцене не входит в обязательный сценарий.

### Резервный сценарий

- Проверенный hotspot и записанное видео полного успешного сценария.
- Backup и проверенная инструкция восстановления.
- Отдельный явно обозначенный offline profile со строгими static identities, если Firebase недоступен. Не переключаться с Google login незаметно для зрителей и не менять ради этого cloud configuration.
- Английский presentation runbook с ожидаемым результатом каждого шага.

**Условие завершения:** полная репетиция на презентационном Mac проходит от открытия продукта до показа UI и IDE; сохранены результаты проверок, команды подготовки и восстановления.

## Передача результата

Передать изменения в новых ветках, подготовленный GDL product, per-gear SQLite support, deployment assets, Firebase/demo AuthN adapter и demo authorization policy, Settings remote contract, transactional event integration, исправленный EB notification fallback, UI SDK/shell и четыре UI-модуля, private photo bundle, команды prepare/deploy/reset/backup/restore, результаты приёмки и английский runbook.

Исходный план сохранять как согласованную постановку; результаты выполнения и найденные ограничения фиксировать в execution notes. Изменения в scope не подменять предположениями о дедлайне.

## Граница реализации

В обязательный объём не входят IRM, Types Registry V2, Postgres event backend, distributed EB roles, runtime UI federation, универсальный deployment framework и обязательное создание продукта через AI-chat.

Расширенное управление consumer groups, ручной pause/resume, дополнительные сценические эпизоды и AI-chat — отдельные расширения. Согласованные GDL UI declarations, четыре UI-модуля, Cluster, Deploy, EB inspector и семейная сцена остаются в основном объёме.

План не требует даты выступления и не содержит календарных обещаний. Обязательный Firebase preflight уже завершён; остальные фазы принимаются по указанным условиям завершения.
