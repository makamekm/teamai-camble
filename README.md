# Camble Release plugin for TeamAI

Репозиторий содержит декларативный manifest `teamai-plugin.json` и проверенный GitHub Actions workflow для Android cloud build. TeamAI не загружает и не исполняет workflow-код на своём сервере: он передаёт только точные SHA и отслеживает GitHub run через REST API.

## Подключение

1. Откройте настройки проекта Camble в TeamAI.
2. Укажите GitHub HTTPS token проекта с read/write доступом к `ruletvorg/application3` и `ruletvorg/backend`.
3. В секции «Плагины проекта» добавьте `https://github.com/makamekm/teamai-camble`.
4. Откройте страницу «Плагины» и нажмите «Собрать данные» в нужной вкладке.

Настраивать URL и запускать deploy может только администратор. Читать manifest/history, обновлять manifest и собирать свежий snapshot может любой вошедший пользователь.

## Preprod

«Собрать данные» читает через GitHub REST точные SHA веток `application3:dev` и `backend:dev`, затем перечисляет каталоги непосредственно в `backend/services/`. Diff и список изменённых файлов не запрашиваются и не используются: выбор сервисов всегда ручной.

Deploy меняет только refs для выбранных пунктов:

- `application3` обновляет `application3:preprod` до сохранённого `application3:dev` SHA;
- `component` обновляет `backend:preprod` до сохранённого `backend:dev` SHA;
- любой другой выбранный каталог `services/<service>` создаёт новый immutable lightweight tag `<service>-N` на сохранённом `backend:dev` SHA и обновляет branch `tags/<service>` до того же SHA.

Имена используются буквально. В частности, `admin-ui` остаётся `admin-ui` и никогда не преобразуется в `admin`. Невыбранные сервисы не создают и не обновляют ни одного ref.

## Prod

«Собрать данные» сохраняет SHA `application3:preprod` и `backend:preprod`. Deploy всегда продвигает оба репозитория целиком:

- `application3:preprod` → `application3:prod`;
- `backend:preprod` → `backend:prod`.

## Защита от гонок

Каждый deploy принимает ID сохранённого snapshot. Перед первой GitHub-мутацией TeamAI проверяет, что snapshot последний, manifest не менялся, а все source refs всё ещё указывают на сохранённые SHA. При расхождении нужно снова нажать «Собрать данные». Для одного plugin environment одновременно разрешён только один deploy.

GitHub операции не транзакционны: при внешней ошибке уже выполненные шаги не откатываются. Поэтому TeamAI сохраняет точный план, поэтапный прогресс, ошибку и историю для ручного разбора частичного результата.

## Android cloud build

Кнопка «Собрать и отправить» запускает `.github/workflows/android-build.yml` на точных SHA `application3:dev` и `backend:dev`. Workflow:

1. клонирует оба private-репозитория по SHA;
2. выполняет `npm run preinit` с локальным `BACKEND_DIR`;
3. собирает подписанные APK и AAB с уникальным `versionCode`;
4. загружает AAB в Google Play Internal;
5. создаёт публичный GitHub Release с `camble.apk`, `camble.aab` и `build-info.json`.

TeamAI допускает только один cloud build одновременно, продолжает reconciliation через cron после перезапуска и удаляет releases старше последних пяти.

Actions secrets:

- `BUILD_REPOSITORY_TOKEN` — read private `ruletvorg/application3` и `ruletvorg/backend`;
- `ANDROID_UPLOAD_KEYSTORE_BASE64`;
- `ANDROID_UPLOAD_STORE_PASSWORD`;
- `ANDROID_UPLOAD_KEY_ALIAS`;
- `ANDROID_UPLOAD_KEY_PASSWORD`;
- `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`.
