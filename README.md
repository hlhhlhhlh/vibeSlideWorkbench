# SlideBranch

SlideBranch 用整页图片制作演示稿。每页可以保存多个生成、上传或编辑得到的图片版本，采用的版本用于导出。

## 本地运行

需要 JDK 21 和 Maven。Windows 上若 `java -version` 显示 Java 8，先在当前 PowerShell 中设置 JDK 路径。下面是这台电脑上的示例。

```powershell
$env:JAVA_HOME = 'D:\back\JAVA_21'
mvn package
& "$env:JAVA_HOME\bin\java.exe" -jar target/slidebranch.jar
```

打开 [http://127.0.0.1:8080](http://127.0.0.1:8080)。Windows 新安装 Maven 后，新开 PowerShell 以加载更新的 PATH。

首次运行默认进入本地演示模式。生成原图时使用占位图，修改时在父图上叠加本次指令，便于在没有 API 密钥时验证整个流程。

## 使用 RightAPI 生图与编辑

打开工作台右上角「设置」，填写 RightAPI 密钥、模型和尺寸并保存。设置适用于本机所有演示稿，重启后自动加载。密钥使用当前 Windows 账户加密保存在数据目录的 `settings.properties` 中。保留密钥框为空可单独调整模型或尺寸。

也可以通过环境变量配置。在项目目录打开 PowerShell，输入具有 GPT Image 绘图权限的 RightAPI 渠道密钥，再启动后端。

```powershell
$env:RIGHTAPI_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'RightAPI Key' -AsSecureString)).Password
& 'D:\back\JAVA_21\bin\java.exe' -jar target/slidebranch.jar
```

启动信息中的 `[rightapi]` 表示已选择中转服务。默认使用 `gpt-image-2` 和 1536×864，可通过 `IMAGE_MODEL` 和 `IMAGE_SIZE` 修改。服务地址默认是 `https://api.site/v1`，覆盖时使用 `RIGHTAPI_BASE`。同时配置两种密钥时，新任务优先使用 RightAPI。

生成新方案提交到 `/images/generations`，编辑已有图片提交到 `/images/edits`，使用 JSON 携带参考图。后端每 3 秒查询一次任务，收到图片地址后下载并保存到本页。详见 [RightAPI 绘图文档](https://docs.rightapi.ai/docs/rc_draw/)。

## 接入其他 OpenAI 兼容生图服务

在启动 Java 的同一个终端中把密钥配置为 `IMAGE_API_KEY`。其他变量可选。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `IMAGE_API_KEY` | 空 | API 密钥，放在服务端进程环境中 |
| `IMAGE_API_BASE` | `https://api.openai.com/v1` | 图像 API 基地址 |
| `IMAGE_MODEL` | `gpt-image-2` | 模型名称 |
| `IMAGE_SIZE` | `1536x864` | 模型输出尺寸，根据所用服务调整 |
| `SLIDEBRANCH_DATA` | `data` | SQLite、素材和导出目录 |
| `SLIDEBRANCH_PORT` | `8080` | 本地 HTTP 端口 |

原图生成调用 `POST /images/generations`，修改调用 `POST /images/edits`，编辑图像以 multipart 字段 `image[]` 提交。适配器读取响应的 `data[0].b64_json`，接收 PNG 或 JPEG。自定义服务需要提供兼容的接口。

## 前端对接：页面与图片版本

以下路径均以 `/api` 为前缀。创建页面、保存要求、提交任务和上传图片成功时返回 HTTP 201 和 `{"id": ...}`。旧版页面标题和改名接口保留兼容。

| 操作 | 请求 | 前端处理 |
| --- | --- | --- |
| 添加页面 | `POST /decks/{deck}/slides`，传 `{}`；可传 `after` 指定插入位置 | 用返回的页面 ID 关联数据，按页序显示页码 |
| 读取演示稿 | `GET /decks/{deck}` | 用 `slide_id` 筛选本页的 `nodes`、`jobs`、`boards`。图片按 ID 升序返回，可逆序展示。每页可有多个 `parent_id: null` 的版本 |
| 保存页面要求 | `POST /slides/{slide}/requirements`，传当前 `revision`、`page_type`、`required_text`、`content`、`local_style` | 返回 `id` 和 `revision`，值为本页要求版本号。内容相同时版本号不变。旧 `/board` 路径和 `board` 参数仍可使用 |
| 生成新方案 | `POST /slides/{slide}/generate`，如 `{"board":8}` | 返回任务 ID。可传补充说明 `instruction`。使用当前页面要求和项目风格调用生图接口 |
| 修改图片 | 同一接口，如 `{"board":8,"parent":12,"instruction":"保留排版，把年份改为 2026"}` | 返回任务 ID。`parent` 可选本页任意图片。编辑接口接收该图和修改指令。省略或留空指令时，后端比较来源图与当前的页面要求；没有差异会返回 400。显式填写的指令按原文使用 |
| 上传图片 | `POST /slides/{slide}/upload`，请求体为图片字节，可传 `X-Board-Id` | 返回图片节点 ID。上传图也加入本页的候选版本 |
| 采用图片 | `POST /slides/{slide}/select`，如 `{"node":12}` | 仅在用户点「采用」时调用。预览状态由前端维护，导出读取每页的 `selected_node_id` |
| 重试失败任务 | `POST /slides/{slide}/retry`，如 `{"job":21}` | 用原来的要求快照、父图和提示词提交新任务 |

页面要求直接保存在 `slides`，`requirements_revision` 是本页内递增的版本号。新接口通过 `revision` 检查版本，上传时可用 `X-Requirements-Revision`。版本不符返回 409。同页旧图仍可作为 `parent`。每个 Job 的 `requirements_snapshot_json` 固定当时的要求和项目风格，`image_size` 固定输出尺寸。上传和素材拖入的节点独立保存要求快照，支持之后比较要求变化。

现有前端继续使用 `/board`、`board` 和 `X-Board-Id`。响应中的 `slides[].board_id` 是版本号的兼容别名，`boards` 数组提供当前各页要求；历史快照从 Job 或上传节点读取。`nodes[].generation_job_id`、`nodes[].parent_id` 和 `jobs[].parent_node_id` 也保留为兼容字段，实际表字段分别为 `job_id` 和 `source_node_id`。

首次出图和上传也需要显式采用。若有页面尚未采用图片，导出返回 409。导出任务创建后固定当时的页序和图片，之后换图不影响这次导出。

## 数据关系

数据库使用 SQLite，服务启动时执行 [schema.sql](src/main/resources/schema.sql)。图片存为文件，SQLite 按 SHA-256 记录和复用素材。

| 表 | 关系与用途 |
| --- | --- |
| `decks` | 一套演示稿包含多页和多次导出 |
| `slides` | 管理页序和当前选图，删除页面时保留历史 |
| `assets` | 保存文件名、格式、尺寸和校验值 |
| `library_items` | 保存素材名称和标签，引用去重后的文件 |
| `image_nodes` | 记录所属页面、文件、可选的来源素材和来源 Job；一个 Job 最多有一张结果图 |
| `generation_jobs` | 固定源图、页面要求快照、提示词、模型、尺寸和单价，记录执行状态和估算费用 |
| `exports` | 记录 PPTX 或 PDF 的导出任务 |
| `export_items` | 按导出页序保存当时选中的节点 |

外键限制选图和父节点归属，节点生成后保持不可变。模型调用在数据库事务之外执行，成功后用短事务写入节点和状态。重启后会继续处理排队任务，中断的执行中任务标记为失败，可以从界面重试生成。导出时先保存图片和顺序的快照，再生成 16:9 文件。其他比例的图片按原比例居中，完整保留画面。

应用供本机单用户使用。备份时先停止应用，再复制整个数据目录。

启动时自动升级至数据库版本 4，合并页面要求并移除 `boards` 表。旧页面、图片、采用记录和导出明细沿用原 ID，历史 Job 和上传节点保留原页面要求。旧库没有记录的历史项目风格、尺寸和付费任务价格保留为未知，旧排队任务继续按执行时配置的尺寸处理。迁移在事务中完成，并在提交前检查所有外键。

## 素材库后端接口

以下路径均以 `/api` 为前缀，写请求沿用 `X-SlideBranch: 1`。前端可在现有编辑器中接入这些接口。

| 操作 | 请求 | 响应 / 行为 |
| --- | --- | --- |
| 上传素材 | `POST /library/upload?name=Logo&tag=brand&tag=logo`，请求体为 PNG/JPEG 原始字节 | 201，`{"id":...}`。名称可省略，默认“未命名素材”；标签可重复传 `tag`。中文参数需 URL 编码。最大 20 MB |
| 列表和筛选 | `GET /library?q=Logo&tag=brand` | `{"items":[...]}`，按名称包含关系和标签精确匹配筛选，两个条件同时生效 |
| 素材详情 | `GET /library/{item}` | 返回名称、`tags` 字符串数组、图片尺寸和 `usage_count` |
| 素材图片 | `GET /library/{item}/image` | 返回原始图片，可作为缩略图或预览来源 |
| 编辑名称、标签 | `PATCH /library/{item}`，如 `{"name":"公司 Logo","tags":["品牌","Logo"]}` | 返回更新后的详情，允许只提供一个字段；每个素材最多 20 个标签，每个标签最多 40 字符，重复标签自动去重 |
| 移除素材 | `DELETE /library/{item}` | 软删除素材条目，已有页面图片继续引用原文件 |
| 拖入页面 | `POST /slides/{slide}/library`，如 `{"item":3,"revision":2}` | 201，返回新增图片节点 ID。`revision` 可省略；已有选中图由用户显式采用后切换 |

`usage_count` 按该素材的图片节点数计算。同一页拖两次记两次，删页或删除演示稿后对应节点不计数，恢复页面后重新计入。拖入操作共享文件，基于该图改图才创建 Job，新结果不会增加素材拖入次数。

## Job 与费用

`GET /api/jobs/{job}` 返回任务详情，包括要求快照、`source_node_id`、`retry_of_job_id`、`provider_task_id`、单价和估算费用。RightAPI 返回异步任务号时立即保存，失败或本地超时后仍可用于核对。

价格按用户提供的按次报价配置，以整数美分存储，币种为 USD。

| 模型 | `unit_price_cents` |
| --- | --- |
| `gpt-image-2` | 10 |
| `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst` | 20 |
| `gpt-image-2.6-flare`、`gpt-image-2.6-sunburst` | 20 |
| 本地演示模式 | 0 |

每次提交时固定模型、尺寸和单价。成功后 `estimated_cost_cents` 等于单价，`billing_status` 为 `estimated`。已定价付费任务排队、执行中或失败时为 `pending`，金额留空；未配置价格的模型和旧付费任务为 `unknown`。本地演示任务始终记 0。费用属于估算，失败和超时调用的实际收费需要供应商确认。重试沿用原要求快照、源图和提示词，新建 Job，并按重试时选择的模型和价格记录。

`GET /api/decks/{deck}/costs` 返回 `currency`、`estimated_cost_cents`、`job_count`、`pending_job_count` 和 `unknown_job_count`，演示稿详情也包含同样的 `costs` 字段。累计费用包含已删除页面的 Job，删除演示稿后仍可读取其费用汇总。若调用期间删页，已完成的生成结果和费用仍会保存。

完整字段和关系见 [数据库设计](docs/database-design.md)。
