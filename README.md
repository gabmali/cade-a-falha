# Cadê a Falha?

[**Abrir a prévia pública do Cadê a Falha?**](https://minolta-undo-tile-structure.trycloudflare.com/)

A prévia é gratuita e abre sem login. O endereço funciona enquanto o computador que hospeda o site estiver ligado e o túnel estiver ativo.

Diagnóstico de páginas públicas em português do Brasil. A interface roda no navegador e envia o endereço ao servidor pela rota `POST /api/analisar`.

## Iniciar a prévia

Com Node.js 22 ou superior e pnpm, execute na pasta do projeto:

```powershell
pnpm install --frozen-lockfile
pnpm start
```

Abra [a prévia local](http://127.0.0.1:4173/). Com as dependências instaladas, também é possível iniciar com `node server.mjs`. Use `pnpm dev` para reiniciar o servidor automaticamente durante edições.

## Publicar a prévia

### Teste público temporário no GitHub Codespaces

1. [Crie um Codespace da branch `main`](https://codespaces.new/gabmali/cade-a-falha/tree/main) na sua conta GitHub. O ambiente prepara as dependências e executa os testes.
2. No terminal do Codespace, execute `npm run preview:codespaces`. O servidor imprime o endereço HTTPS da prévia.
3. Na aba **Ports**, abra o menu da porta **4173** e selecione **Port Visibility → Public**. Copie o endereço encaminhado e teste-o em uma janela anônima antes de compartilhar.

O link pode ser aberto por qualquer pessoa enquanto a prévia e o Codespace estiverem ativos. Se o Codespace for suspenso, reinicie o servidor e confira a visibilidade da porta. Consulte a [cota de uso do GitHub Codespaces](https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage) na sua conta.

### Hospedagem no Render

O [atalho para publicar no Render](https://render.com/deploy?repo=https://github.com/gabmali/cade-a-falha) usa o arquivo `render.yaml` da branch `main`. Entre no Render, confira o plano **Free** e crie o serviço. Quando o serviço estiver ativo, abra o endereço HTTPS `onrender.com` exibido no painel. O plano gratuito pode demorar para responder depois de um período sem acesso.

O build instala as dependências pelo lockfile e executa os testes. Novos commits podem ser publicados pelo painel do Render. Antes de compartilhar o endereço, confira se `/healthz` responde, analise `example.com` e confirme que `http://127.0.0.1` é rejeitado.

## Testar

```powershell
pnpm test
```

- Use `example.com` para conferir a normalização para HTTPS e o relatório de uma página pública.
- Use `https://the-internet.herokuapp.com/status_codes` para conferir o destino que retorna HTTP 404.
- Use `endereço inválido` e `http://192.168.1.1` para conferir a validação.
- A suíte simula respostas DNS e HTTP para testar redirecionamentos para IPs privados sem depender de um serviço público que os emita.

## Escopo

Uma análise verifica a resposta HTTP, o protocolo final, o título, a configuração de visualização para celular e até 10 destinos únicos no mesmo domínio da página final. O relatório descreve o HTML recebido e a amostra de links. Formulários, compras, JavaScript do site e alterações automáticas ficam fora do escopo.

O servidor valida os destinos antes de conectar e usa os IPs aprovados na própria conexão. As consultas têm limite de 16 segundos por análise, 5 segundos por etapa HTTP, quatro redirecionamentos por destino e 1 MB de HTML, inclusive após descompactação. A prévia permite duas análises em paralelo, com até três destinos por análise em andamento.

Na versão pública, cada visita pode iniciar até quatro análises por minuto, com limite total de 12 análises e 80 tentativas de saída por minuto em uma instância. Os contadores ficam em memória e usam identificadores derivados do endereço IP. A versão pública permite conexões externas apenas nas portas padrão de HTTP e HTTPS e bloqueia o próprio endereço do serviço.

O app processa os endereços submetidos em memória para gerar o relatório. As páginas consultadas recebem requisições do servidor de análise. Use endereços públicos e evite URLs com senhas, tokens ou dados pessoais.
