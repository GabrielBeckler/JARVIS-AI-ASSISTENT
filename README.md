# JARVIS AI

Assistente desktop local em desenvolvimento, feito com Tauri 2, React, TypeScript e Rust. O projeto tem como plataforma alvo o Fedora Linux com KDE Plasma e Wayland, com conversas realizadas por meio de um servidor Ollama local.

> **Status:** aplicação local funcional em evolução. Chat com streaming, persistência SQLite e dashboard de métricas reais estão implementados. Voz, gestão de projetos e ferramentas de agente ainda não fazem parte do fluxo atual.

## Índice

- [Visão geral](#visão-geral)
- [Estado do projeto](#estado-do-projeto)
- [Arquitetura atual](#arquitetura-atual)
- [Requisitos](#requisitos)
- [Instalação no Fedora](#instalação-no-fedora)
- [Configuração do ambiente](#configuração-do-ambiente)
- [Configuração do Ollama](#configuração-do-ollama)
- [Execução e build](#execução-e-build)
- [Privacidade e segurança](#privacidade-e-segurança)
- [Estrutura do repositório](#estrutura-do-repositório)
- [Roadmap](#roadmap)
- [Referências oficiais](#referências-oficiais)

## Visão geral

O objetivo do JARVIS AI é oferecer um assistente pessoal que funcione localmente, converse em português brasileiro e, ao longo das próximas fases, ajude a acompanhar o computador e organizar projetos de desenvolvimento.

| Área | Tecnologia ou alvo |
| --- | --- |
| Aplicação desktop | Tauri 2 |
| Interface | React 19, TypeScript e Vite |
| Backend nativo | Rust |
| Banco local | SQLite com migration versionada e importação do histórico legado |
| Modelo padrão | Ollama com Qwen 3.5 4B (editável na aba **IA**) |
| Sistema alvo | Fedora 44, KDE Plasma e Wayland |
| Hardware de referência | Intel Core i5-12450H, NVIDIA RTX 2050 4 GB e 16 GB de RAM |

O uso do Ollama e a execução local do modelo não exigem uma conta ou uma API comercial. É necessária uma conexão com a internet para instalar as dependências e baixar o modelo pela primeira vez. Depois do download, o Ollama pode executar o modelo localmente.

## Estado do projeto

| Recurso | Estado atual |
| --- | --- |
| Interface desktop de três áreas | Implementada; janela configurada para 1440×900, mínimo 1000×680 |
| Chat textual com Ollama | Streaming pelo backend Rust; falhas são repetíveis, cancelamento descarta a resposta tardia e respostas parciais ficam marcadas como incompletas |
| Verificação da API local do Ollama | Estado do serviço separado do estado do modelo |
| Histórico de conversas | SQLite no diretório de dados Tauri; importa uma vez a chave legada `jarvis.conversations` e mantém a cópia de compatibilidade |
| Configuração do endpoint e modelo | Endereço configurável por Vite em loopback; modelo e permanência ajustáveis na aba **IA** |
| Monitoramento de CPU, GPU, RAM e temperaturas | Coleta local independente por campo; sensores indisponíveis aparecem como N/D |
| Renderização de respostas | Markdown sem HTML bruto nem imagens remotas automáticas; links são filtrados |
| Cadastro, pesquisa e permissões de projetos | Gestão de projetos ainda não implementada; a busca atual pesquisa títulos de conversas |
| Wake word, captura, STT e TTS | Não implementados; o botão de microfone está indisponível |
| Empacotamento e validação do RPM | Ainda não validados |

O SQLite é a fonte persistente principal depois da inicialização. Conversas antigas em `localStorage` são importadas em uma transação e a chave original não é removida. Os dados do dashboard são leituras da máquina atual, não um inventário fixo de hardware.

## Arquitetura atual

```mermaid
flowchart LR
    UI[React no WebView] -->|comandos e streaming| R[Rust / Tauri 2]
    R -->|HTTP loopback| API[Ollama local]
    R -->|transações curtas| DB[(SQLite em app_data_dir)]
    UI -. cópia de compatibilidade/importação única .-> LS[localStorage]
    R -->|/proc, sysfs, hwmon e ferramentas locais| HW[Métricas do sistema]
```

O React usa comandos Tauri assíncronos para consultar modelos e enviar chat. O stream NDJSON é analisado incrementalmente em Rust e encaminhado ao React por canal Tauri. As conversas são persistidas no arquivo `jarvis.db` dentro do diretório de dados do aplicativo. O dashboard chama uma coleta nativa a cada dois segundos enquanto a aba Sistema está ativa.

## Requisitos

- Fedora Linux com ambiente gráfico; KDE Plasma e Wayland são a plataforma alvo do produto.
- Node.js compatível com a versão instalada do Vite. Para Vite 8, use Node.js `20.19+` ou `22.12+`.
- npm.
- Rust stable e Cargo, instalados pelo `rustup`.
- Dependências de desenvolvimento Linux do Tauri e WebKitGTK 4.1.
- Ollama instalado e acessível localmente para usar o chat.

## Instalação no Fedora

### 1. Instale as dependências nativas do Tauri

Os pacotes abaixo seguem a lista de dependências Linux/Fedora da documentação do Tauri:

```bash
sudo dnf check-update
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

### 2. Instale Node.js e Rust

Instale uma versão compatível do Node.js e o Rust stable. Consulte as instruções oficiais em [Node.js](https://nodejs.org/en/download) e [Rust](https://www.rust-lang.org/tools/install). Confirme que os comandos estão disponíveis:

```bash
node --version
npm --version
rustc --version
cargo --version
```

### 3. Prepare o projeto

Na pasta do repositório:

```bash
npm ci
cp .env.example .env.local
```

Edite `.env.local` se precisar usar outro endereço ou modelo. Esse arquivo é local e está ignorado pelo Git.

## Configuração do ambiente

O arquivo versionado [`.env.example`](.env.example) contém os valores padrão:

```dotenv
VITE_OLLAMA_BASE_URL=http://127.0.0.1:11434
VITE_OLLAMA_MODEL=qwen3.5:4b
```

| Variável | Descrição | Padrão |
| --- | --- | --- |
| `VITE_OLLAMA_BASE_URL` | Endereço base do Ollama. Não inclua `/api` no final. | `http://127.0.0.1:11434` |
| `VITE_OLLAMA_MODEL` | Nome do modelo local usado inicialmente pelo chat. | `qwen3.5:4b` |

O Vite carrega `.env.local` durante desenvolvimento e build. Variáveis com prefixo `VITE_` são incluídas no frontend e **não são apropriadas para segredos, senhas ou chaves privadas**. O projeto não precisa de uma chave de API para o Ollama local.

## Configuração do Ollama

Instale o Ollama pelas [instruções oficiais para Linux](https://docs.ollama.com/linux). Baixe o modelo configurado no exemplo:

```bash
ollama pull qwen3.5:4b
ollama list
```

O serviço do Ollama normalmente atende em `127.0.0.1:11434`. Se ele não estiver ativo como serviço, inicie-o em um terminal:

```bash
ollama serve
```

Confira a API local:

```bash
curl http://127.0.0.1:11434/api/tags
```

### Comunicação local com o Ollama

O React chama comandos assíncronos Tauri; o backend Rust faz as requisições para o endereço configurado, que deve ser HTTP em loopback (`localhost` ou `127.0.0.1`). Assim, o WebView não acessa a API do Ollama diretamente e não precisa de configuração CORS. O backend rejeita endereços remotos. Mantenha o Ollama vinculado a loopback; não exponha a API em `0.0.0.0`.

## Execução e build

| Comando | Finalidade |
| --- | --- |
| `npm run tauri dev` | Inicia a aplicação desktop em modo de desenvolvimento. |
| `npm run dev` | Inicia somente o servidor de desenvolvimento web do Vite. |
| `npm run build` | Verifica os tipos TypeScript e gera os arquivos web de produção. |
| `npm run tauri build` | Gera o pacote desktop com Tauri para a plataforma local. |

O suporte a RPM aparece como meta na especificação do produto, mas a configuração e o resultado do empacotamento ainda precisam ser validados no Fedora.

## Privacidade e segurança

- As mensagens são enviadas pelo backend Rust ao Ollama local. O histórico principal fica em SQLite no diretório de dados do aplicativo Tauri (`jarvis.db`); a chave `jarvis.conversations` do WebView é mantida como cópia de compatibilidade e fonte da importação legada.
- O padrão aponta para loopback (`127.0.0.1`); não configure um servidor remoto se quiser manter o processamento nesta máquina.
- O download inicial do Ollama e do modelo requer internet. Este protótipo não chama uma API comercial.
- O app não captura áudio atualmente. Não há gravação de áudio ou transcrição implementada.
- `.env.local` pode conter configurações locais; nunca adicione arquivos `.env` ao Git. O `.env.example` deve conter somente valores públicos e genéricos.
- Permissões por projeto, confirmação de ações do agente e recursos de voz ainda não existem. A coleta de temperatura e estatísticas da GPU depende do driver e dos sensores disponíveis; velocidade da RAM pode não estar acessível sem uma fonte EDAC/SMBIOS legível.

## Estrutura do repositório

```text
.
├── public/                 # Recursos estáticos da interface
├── src/                    # Interface React e configuração de tipos Vite
├── src-tauri/              # Aplicação nativa, configuração, capacidades e ícones
├── .env.example            # Modelo versionado de configuração local
├── package.json            # Scripts e dependências JavaScript
└── README.md               # Documentação do projeto
```

## Roadmap

O plano de trabalho segue a especificação funcional do JARVIS AI:

1. **Fundação:** chat local, streaming, configuração, histórico SQLite e métricas de hardware implementados; estabilização e empacotamento RPM pendentes.
2. **Projetos:** cadastro e gestão de workspaces, busca de conteúdo e associação ao histórico.
3. **Voz:** detecção de palavra de ativação, VAD, transcrição e síntese locais.
4. **Contexto e memória:** indexação autorizada de arquivos e memória controlável.
5. **Agente:** ferramentas locais supervisionadas e registro das operações.

## Referências oficiais

As referências abaixo documentam as ferramentas, os requisitos e a sintaxe usada neste repositório. A estrutura em seções e links segue práticas de documentação para repositórios e Markdown descritas pela Microsoft e pelo GitHub.

- **Microsoft Learn:** [README e Wiki de projetos no Azure DevOps](https://learn.microsoft.com/en-us/azure/devops/project/wiki/about-readme-wiki) — documentação de README e wiki para projetos.
- **GitHub Docs (Microsoft):** [Formatação básica de Markdown](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) — títulos, links, listas e blocos de código.
- **Tauri:** [Pré-requisitos para Linux e Fedora](https://v2.tauri.app/start/prerequisites/) e [configuração](https://v2.tauri.app/reference/config/).
- **Ollama:** [API de chat](https://docs.ollama.com/api/chat), [FAQ e configuração local](https://docs.ollama.com/faq) e [biblioteca Qwen 3.5 4B](https://ollama.com/library/qwen3.5:4b).
- **Rust:** [Instalação oficial](https://doc.rust-lang.org/book/ch01-01-installation.html).
- **React:** [Documentação oficial](https://react.dev/learn).
- **Vite:** [Guia de início e requisitos do Node.js](https://vite.dev/guide/).
- **Tauri SQL Plugin:** [Documentação do plugin e migrations](https://docs.rs/tauri-plugin-sql/latest/tauri_plugin_sql/).
- **SQLite:** [Documentação oficial](https://www.sqlite.org/docs.html).
- **Fedora:** [Documentação oficial do Fedora](https://docs.fedoraproject.org/).
