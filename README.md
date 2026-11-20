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
| 保存页面要求 | `POST /slides/{slide}/board`，传当前 `board`、`page_type`、`required_text`、`content`、`local_style` | 返回要求快照 ID。内容相同时返回原 ID。旧图、已采用的图片和已提交的任务都会保留 |
| 生成新方案 | `POST /slides/{slide}/generate`，如 `{"board":8}` | 返回任务 ID。可传补充说明 `instruction`。使用当前页面要求和项目风格调用生图接口 |
| 修改图片 | 同一接口，如 `{"board":8,"parent":12,"instruction":"保留排版，把年份改为 2026"}` | 返回任务 ID。`parent` 可选本页任意图片。编辑接口接收该图和修改指令。省略或留空指令时，后端比较来源图与当前的页面要求；没有差异会返回 400。显式填写的指令按原文使用 |
| 上传图片 | `POST /slides/{slide}/upload`，请求体为图片字节，可传 `X-Board-Id` | 返回图片节点 ID。上传图也加入本页的候选版本 |
| 采用图片 | `POST /slides/{slide}/select`，如 `{"node":12}` | 仅在用户点「采用」时调用。预览状态由前端维护，导出读取每页的 `selected_node_id` |
| 重试失败任务 | `POST /slides/{slide}/retry`，如 `{"job":21}` | 用原来的要求快照、父图和提示词提交新任务 |

`slides[].board_id` 表示当前页面要求。`nodes[].board_id` 和 `jobs[].board_id` 表示生成、编辑或上传时记录的要求快照，可在 `boards` 中按 ID 查找。提交生成或编辑时建议传当前 `board`；如果已经被更新，接口返回 409，刷新后可重新提交。同页旧图仍可作为 `parent`。

首次出图和上传也需要显式采用。若有页面尚未采用图片，导出返回 409。导出任务创建后固定当时的页序和图片，之后换图不影响这次导出。

## 数据关系

数据库使用 SQLite，服务启动时执行 [schema.sql](src/main/resources/schema.sql)。图片存为文件，SQLite 按 SHA-256 记录和复用素材。

| 表 | 关系与用途 |
| --- | --- |
| `decks` | 一套演示稿包含多页和多次导出 |
| `slides` | 管理页序和当前选图，删除页面时保留历史 |
| `assets` | 保存文件名、格式、尺寸和校验值 |
| `boards` | 保存底板及其所属页面，每页最多一块活动底板 |
| `image_nodes` | 记录所属页面、要求快照和可选的来源图 |
| `generation_jobs` | 固定父节点和本次指令，记录排队、执行、成功、失败 |
| `exports` | 记录 PPTX 或 PDF 的导出任务 |
| `export_items` | 按导出页序保存当时选中的节点 |

外键限制选图和父节点归属，节点生成后保持不可变。模型调用在数据库事务之外执行，成功后用短事务写入节点和状态。重启后会继续处理排队任务，中断的执行中任务标记为失败，可以从界面重试生成。导出时先保存图片和顺序的快照，再生成 16:9 文件。其他比例的图片按原比例居中，完整保留画面。

应用供本机单用户使用。备份时先停止应用，再复制整个数据目录。

启动时自动升级至数据库版本 2。旧页面、图片、采用记录和导出明细沿用原 ID，以往停用底板上的图片也会出现在该页的历史版本中。
