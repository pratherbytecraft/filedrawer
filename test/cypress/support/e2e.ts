// cy.page('window/index.html?path=/Users/test', change) loads a renderer
// page with the fake window.filedrawer in place. change(state, extra) can
// adjust the state, and extra.tree the made up folders (see fake.ts), before
// the page reads them. cy.fake() yields the fake.
import { fakeFiledrawer, type Extra, type Fake } from './fake';
import type { State } from '../../../src/shared/types';

declare global {
  namespace Cypress {
    interface Chainable {
      page(url: string, change?: (state: State, extra: Extra) => void): Chainable<void>;
      fake(): Chainable<Fake>;
      calls(name: string): Chainable<unknown[][]>;
    }
  }
}

Cypress.Commands.add('page', (url: string, change?: (state: State, extra: Extra) => void) => {
  cy.task<string[]>('apiNames', null, { log: false }).then((names) => {
    cy.task<State>('filedrawerState', null, { log: false }).then((state) => {
      const extra: Extra = {};
      if (change) change(state, extra);
      cy.visit(`${Cypress.env('pages')}/${url}`, {
        onBeforeLoad(win) {
          win.filedrawer = fakeFiledrawer(names, state, extra);
        }
      });
    });
  });
});

Cypress.Commands.add('fake', () => cy.window({ log: false }).then((win) => win.filedrawer as Fake));

// The calls the page made to one of the fake's functions, as argument lists.
// Retries like any query, so should() waits for a call to come in.
Cypress.Commands.addQuery('calls', (name: string) => {
  return () => {
    // cy.state is Cypress's own, left out of its types.
    const api = (cy as unknown as { state(key: 'window'): Window }).state('window').filedrawer as Fake;
    return api.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
  };
});
