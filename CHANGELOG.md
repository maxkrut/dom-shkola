# Changelog

## 1.0.3 - 2026-11-19

**Безопасность.** Карта использует MapLibre GL JS 6.4.1 вместо 6.0.0. Эта версия исправляет уязвимость межсайтового скриптинга (XSS) при обработке HTML. [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579)

<details>
<summary>English</summary>

**Security.** The map now uses MapLibre GL JS 6.4.1, upgraded from 6.0.0. This fixes a cross-site scripting (XSS) vulnerability in HTML sanitization. [GHSA-jrc7-96c5-q579](https://github.com/advisories/GHSA-jrc7-96c5-q579)

</details>

## 1.0.2 - 2026-11-19

Выпуск использует адреса, координаты и закрепления из 1.0.1. Предложенные изменения по 13 районам отложены до сверки с районными источниками.

- **Карта.** Фиолетовый контур у школы № 142 Выборгского района показывает, что граница построена по приблизительным точкам адресов. При выборе школы контур подсвечивается синим. В карточке появилось пояснение и указание сверять закрепление дома с документом.
- **Счётчики школ.** Сайт рассчитывает число адресов и число записей о закреплении по опубликованному реестру. У школы № 75 Петроградского района теперь отображается 81 действующий адрес вместо 80. У школы № 99 того же района 123 действующих адреса, на которые приходится 245 действующих записей.
- **Публикация.** Сборка останавливается, если в поставке отсутствуют тайлы, файлы реестра или страницы документов, если карта и адресный индекс расходятся по контурам или школам либо если размер сайта превышает 1 ГБ.

<details>
<summary>English</summary>

This patch uses the addresses, coordinates and school assignments from 1.0.1. Proposed changes across 13 districts are pending verification against district sources.

- **Map.** School 142 in Vyborgsky District has a purple outline because its area was drawn around approximate address points. Selecting the school highlights it in blue. The school card explains how to confirm a home's assignment in the official document.
- **School totals.** Address and assignment counts now come from the published register. School 75 in Petrogradsky District shows 81 current addresses, up from 80. School 99 in the same district has 123 current addresses across 245 current assignment records.
- **Publication.** The build stops if the package is missing referenced tiles, register files or document pages, if the map and address index disagree on areas or their schools, or if the site exceeds 1 GB.

</details>

## 1.0.1 - 2026-11-11

- Viewer: keep school areas visible when an address is selected; clearer shared-area labels and `∩` badges on the map.
- Mobile: map refit when showing the map; screen-reader labels on the map toggle; readable «О проекте» table on narrow screens.
- SNT: «Информация о СНТ» instead of a misleading boundary button; district in the card; garden rows stay expanded in school lists.
- Documents: single-document schools hide the redundant selector; deduplicated rule lines; PDF fragment scroll centers on the highlighted row.
- School card: explain map marker when the building address is missing in the register.

## 1.0.0 - 2026-11-08

- Search for schools and addresses in Saint Petersburg.
- View assigned addresses and approximate school areas on an interactive map.
- Open excerpts and links to official district documents.
