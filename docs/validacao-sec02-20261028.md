# SEC-02 — validação com o dump histórico fornecido

Data: 28/10/2026. Issues: [API #17](https://github.com/eduardobaptist/gate2way-api/issues/17) e [frontend #30](https://github.com/eduardobaptist/gate2way-frontend/issues/30).

## Origem e abrangência

Foi inventariado o snapshot `gate2way-prod.sql` disponibilizado no workspace. Todos os cinco projetos desse dump entraram na amostra anonimizada: cobertura integral dos formatos encontrados nesse snapshot, sem selecionar apenas registros favoráveis. Não foi consultada produção atual; isto não afirma que o dump representa alterações posteriores do ambiente de destino.

- Todos os cinco registros têm JSON objeto em `estilo`, com 13 widgets.
- Quantidades de colunas individuais não vazias por amostra: 3, 0, 7, 13 e 0.
- Um projeto contém duas diferenças entre as colunas e os textos do JSON. A preservação exige manter ambas as versões e bloquear a edição conflitante; esses dados não foram reconciliados automaticamente.
- Coluna real: `LONGTEXT`, InnoDB, com `CHECK (json_valid(estilo))` ativo. Não é uma coluna nativa JSON.

SHA-256 do dump de origem: `a7206874abc44a688e84c9c6fa8413582dfbfec51262c8190c8376df02ebb5df`.

## Isolamento, anonimização e restauração

- Container MySQL 8.0.31 separado, `gate2way-sec02-20261028`, publicado apenas em `127.0.0.1:3310`.
- Dump original restaurado somente em `source_snapshot`, dentro desse container. A diretiva inicial de sandbox MariaDB foi ignorada por incompatibilidade do cliente MySQL; nenhum esquema foi convertido.
- Amostra em `canvas_sample_v2`: textos, contatos, identificadores de contato e senhas substituídos; IDs relacionais preservados para integridade. Strings do JSON foram pseudonimizadas de forma determinística, preservando igualdade/divergência, vazios, tipos, estrutura, coordenadas, tokens numéricos e propriedades adicionais. Nenhum conteúdo textual de origem foi publicado.
- Backup da amostra restaurado em `canvas_restored` antes dos testes de edição. As 15 tabelas tiveram contagens, hashes de conteúdo e DDL comparados, com resultado idêntico. Referências entre tabelas também foram conferidas.
- Apenas a cópia restaurada foi preparada em estado de rascunho e recebeu alterações dos testes. A origem do dump e o banco local da porta 3308 não foram modificados.
- O fingerprint das 15 tabelas do banco local da porta 3308 continuou idêntico após a validação.

SHA-256 do backup anonimizado testado: `c3c6a7f11d47027595991da9044133258db08148115342f5ccc2547f174ecbfd`. O backup e as credenciais de teste ficam somente em diretório temporário privado; não estão versionados.

## Problema real reproduzido e correção mínima

Antes da correção, um payload produzido pelo frontend existente, para um Canvas reconhecido e consistente, recebia `503 CANVAS_STORAGE_UNVERIFIED`, pois a API aceitava somente coluna nativa JSON. O estado persistido foi conferido e permaneceu intacto nessa rejeição.

A API agora aceita também `LONGTEXT` quando confirma, sob a mesma transação/locks existentes, uma restrição ativa equivalente a `JSON_VALID(estilo)` na tabela atual. Sem a restrição, com validação de outra coluna ou expressão permissiva como `OR 1`, a operação continua rejeitada sem atualização parcial.

Permanecem os guardas de transação/InnoDB, revisão, concorrência, formatos desconhecidos, perda numérica, chaves duplicadas, permissões e leitura após persistência. Nenhum model, migration, coluna ou regra de autorização foi alterado. O frontend já suporta a representação textual e não precisou de alteração.

## Evidências de execução

- **114 testes do controller de projetos passaram**, incluindo oito novos casos de armazenamento LONGTEXT. Todos os arquivos de testes de controllers/segurança do backend também passaram.
- **79 testes do Canvas do frontend passaram.**
- **Build do frontend passou.** Avisos preexistentes de sourcemap, Browserslist, Lottie e tamanho do bundle permanecem fora deste escopo.
- Nos cinco projetos anonimizados, título e descrição foram atualizados por payloads produzidos pelo frontend, mantendo `estilo` bruto e as 13 colunas sem alterações.
- Nos quatro projetos consistentes, texto de 255 caracteres e limpeza intencional foram persistidos, preservando os demais campos e widgets.
- No projeto divergente, o frontend bloqueou a edição do Canvas e a API rejeitou tentativa de alterar uma das representações divergentes com 409. Nem o Canvas nem outro campo do mesmo envio foram parcialmente gravados.
- Duas requisições realmente concorrentes ao MySQL, com a mesma revisão: **200/409**. O texto persistido correspondeu à requisição vencedora.
- Revisão inválida e tentativa de alterar Canvas pelo contrato legado: **428**, sem atualização parcial.
- Chrome, nas larguras 1440 e 768: amostras consistente e divergente abertas no editor; 13 campos editáveis na primeira e proteção explícita na segunda. Digitação funciona, sem envio automático, erros de JavaScript/API ou overflow. Esses testes de interface bloquearam requisições de escrita; a persistência foi verificada separadamente pelas chamadas reais à API descritas acima.

## Reprodução

Dependências existentes do backend: `.final-backend-20261016/node_modules`, com o mesmo package-lock.json do repositório. Não foram instaladas bibliotecas novas.

```bash
# Na pasta gate2way-api
NODE_PATH=/home/rafaela/gate2way/.final-backend-20261016/node_modules node tests/controllers/projetoController.test.cjs
NODE_PATH=/home/rafaela/gate2way/.final-backend-20261016/node_modules node --test tests/controllers/*.test.cjs tests/security/*.test.cjs

# Na pasta gate2way-frontend
node tests/projetoCanvas.test.js
npm run build
```

Scripts e evidências de homologação desta execução: `/tmp/gate2way-sec02-20261028/` (`prepare.cjs`, `inventory.json`, `backup-evidence.json`, `validate.cjs`, `validation.json`, `browser.py`, `browser-results.json` e logs). São auxiliares locais; a regressão de armazenamento é permanente em `tests/controllers/projetoController.test.cjs`.

## Conclusão e limites

A pendência de amostra histórica e restauração de backup foi atendida para o dump fornecido. A preservação funciona nos formatos encontrados, incluindo a rejeição segura dos registros divergentes. A divergência de conteúdo exige decisão humana para eventual reconciliação, mas não provoca perda de dados ou conversão automática.

A conclusão destas issues não aprova deploy de produção nem declara compatibilidade com formatos que não estejam nesse snapshot. Mudanças futuras de esquema ou novos formatos históricos precisam manter as mesmas verificações conservadoras. `main` e as configurações de produção permanecem inalteradas; a correção é publicada somente em `develop`.
