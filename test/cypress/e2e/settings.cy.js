// The settings window, with every setting at its default unless a test says.
const open = (title) => cy.contains('#nav a', title).click();

describe('settings window', () => {
  it('draws every page from the sidebar', () => {
    cy.page('settings/index.html');
    for (const title of ['Appearance', 'Folder Options', 'Terminal', 'Default File Manager', 'General', 'About']) {
      open(title);
      cy.get('#title').should('have.text', title);
      cy.get('.page.on').should('be.visible');
    }
  });

  it('a switch sends its setting and shows the new state', () => {
    cy.page('settings/index.html');
    open('Folder Options');
    cy.get('.toggle[data-key="showHidden"]').should('not.have.class', 'on').click();
    cy.calls('updateSettings').should('deep.include', [{ showHidden: true }]);
    cy.get('.toggle[data-key="showHidden"]').should('have.class', 'on');
  });

  it('the theme list sends the theme', () => {
    cy.page('settings/index.html');
    cy.get('#theme').select('classic-1995');
    cy.calls('updateSettings').should('deep.include', [{ theme: 'classic-1995' }]);
  });

  it('the buttons on General call the app', () => {
    cy.page('settings/index.html');
    open('General');
    cy.get('#export').click();
    cy.get('#reset').click();
    cy.calls('exportSettings').should('have.length', 1);
    cy.calls('resetSettings').should('have.length', 1);
  });
});
