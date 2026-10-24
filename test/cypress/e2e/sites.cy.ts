// Site Manager, with the fake's sites (support/fake.ts): Work saved with a
// password, homelab and storage from the SSH config, storage ticked.
import type { SitesChange } from '../../../src/shared/types';

const row = (name: string) => cy.contains('#list .row', name);
const saved = () => cy.calls('sitesSave').its(0).its(0).then((c) => c as unknown as SitesChange);

describe('Site Manager', () => {
  it('lists My Sites and the config hosts, and shows the picked one', () => {
    cy.page('sites/index.html');
    cy.get('#list .grp').should('have.length', 2);
    row('Work').should('have.class', 'on');
    cy.get('#f-host').should('have.value', 'files.example.com');
    cy.get('#f-logon').should('have.value', 'password');
    cy.get('#f-pw').should('have.attr', 'placeholder').and('not.be.empty');
    row('homelab').trigger('mousedown');
    cy.get('.src').should('contain.text', '~/.ssh/config');
    cy.get('#f-host').should('be.disabled');
    cy.get('#f-side').should('not.be.checked').and('not.be.disabled');
    cy.get('#b-del').should('be.disabled');
  });

  it('a new site is saved with what was typed, and a config host can be ticked', () => {
    cy.page('sites/index.html');
    cy.get('#b-new').click();
    cy.get('#f-host').should('have.focus').type('nas.lan');
    cy.get('#f-user').type('admin');
    cy.get('#f-logon').select('agent');
    row('homelab').trigger('mousedown');
    cy.get('#f-side').check();
    cy.get('#b-save').click();
    saved().then((c) => {
      expect(c.saved.map((s) => [s.name, s.host, s.user, s.logon])).to.deep.equal([['Work', 'files.example.com', 'me', 'password'], ['New site', 'nas.lan', 'admin', 'agent']]);
      expect(c.configShown).to.have.members(['storage', 'homelab']);
    });
    cy.calls('closeSiteManager').should('have.length', 1);
  });

  it('a site without a host isn\'t saved, and says why', () => {
    cy.page('sites/index.html');
    cy.get('#b-new').click();
    cy.get('#b-connect').click();
    cy.get('#err').should('contain.text', 'Host');
    cy.calls('sitesSave').should('have.length', 0);
  });

  it('a typed password is sent, and a switch away from Password forgets the saved one', () => {
    cy.page('sites/index.html');
    cy.get('#f-pw').type('hunter2');
    cy.get('#b-save').click();
    saved().its('passwords').should('deep.equal', { s1: 'hunter2' });
    cy.page('sites/index.html');
    cy.get('#f-logon').select('key');
    cy.get('#f-key').should('exist');
    cy.get('#b-connect').click();
    saved().its('passwords').should('deep.equal', { s1: null });
    cy.calls('connectSite').should('deep.equal', [['s1']]);
  });

  it('Duplicate copies a config host into My Sites, where it can change', () => {
    cy.page('sites/index.html');
    row('storage').trigger('mousedown');
    cy.get('#b-dup').click();
    row('storage copy').should('have.class', 'on');
    cy.get('#f-host').should('not.be.disabled').and('have.value', 'homelab.local');
    cy.get('#f-user').should('have.value', 'storage');
  });
});
