# Cadê a Falha?

Diagnóstico de páginas públicas em português do Brasil. A interface roda no navegador e envia o endereço para a rota local `POST /api/analisar`.

## Iniciar a prévia

Com Node.js 22 ou superior e pnpm, execute na pasta do projeto:

```powershell
pnpm install --frozen-lockfile
pnpm start
```

Abra [a prévia local](http://127.0.0.1:4173/). Com as dependências instaladas, também é possível iniciar com `node server.mjs`. Use `pnpm dev` para reiniciar o servidor automaticamente durante edições.

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
