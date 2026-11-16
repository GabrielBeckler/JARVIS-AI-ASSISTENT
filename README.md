# JARVIS AI

Assistente desktop local em Tauri 2, React e TypeScript, pensado para Fedora KDE.

## Desenvolvimento

```bash
npm install
npm run tauri dev
```

O chat tenta se conectar à API local do Ollama em `http://127.0.0.1:11434`. O modelo inicial é `qwen3.5:4b`; use o nome de um modelo instalado na aba **IA**. As conversas desta primeira etapa ficam no armazenamento local do WebView.

## Estado da implementação

A interface inicial e o envio de mensagens ao Ollama estão implementados. A checagem de conexão do Ollama também é local. SQLite, cadastro de projetos, leituras reais de hardware, processamento de voz e empacotamento Fedora ainda precisam ser implementados; os painéis marcam como indisponíveis os dados que ainda não são coletados.

O projeto segue as fases da especificação funcional, começando pelo chat textual e pela fundação da interface.
# JARVIS-AI-ASSISTENT
