import userEvent from '@testing-library/user-event';

/**
 * userEvent para os testes, SEM pausa entre as teclas (`delay: null`).
 *
 * Por quê: com o padrão (`delay: 0`), o userEvent espera um `setTimeout(0)` entre cada tecla
 * e devolve a vez ao laço de eventos. Sozinho isso custa pouco, mas na suíte inteira — com a
 * cobertura ligada e vários arquivos rodando em paralelo — cada espera demora mais, e um teste
 * que digita ~20 teclas passou dos 5 s do Vitest de vez em quando (LoginPage, 1 falha em 15
 * rodadas; o mesmo teste levava de 0,5 a 5,2 s). Com `delay: null`, cada tecla continua gerando
 * os mesmos eventos (keydown, input, keyup), só que sem as pausas: o comportamento testado é o
 * mesmo e o tempo cai a cerca de um terço.
 *
 * Use sempre esta função; um teste (user.test.ts) impede chamar o userEvent.setup() direto.
 */
export function setupUser() {
  return userEvent.setup({ delay: null });
}
