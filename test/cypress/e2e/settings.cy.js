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

  it('About lists the other apps, Open for one that\'s installed and its install line for one that isn\'t', () => {
    cy.page('settings/index.html');
    open('About');
    cy.get('.sib[data-key="startbar"]').should('contain', 'Installed').find('code').should('not.exist');
    cy.get('.sib[data-key="startbar"] [data-act="open"]').click();
    cy.calls('openSibling').should('deep.equal', [['startbar']]);
    cy.get('.sib[data-key="shotdrawer"] code').should('have.text', 'npm install -g shotdrawer');
    cy.get('.sib[data-key="shotdrawer"] [data-act="copy"]').click();
    cy.calls('copyText').should('deep.equal', [['npm install -g shotdrawer']]);
    cy.get('.sib[data-key="shotdrawer"] [data-act="copy"]').should('have.text', 'Copied');
  });

  it('General shows the update line for how Filedrawer was installed, with a Copy button', () => {
    cy.page('settings/index.html', (state) => {
      state.updateCommand = 'brew upgrade filedrawer';
      state.update = { state: 'available', latest: '9.9.10' };
    });
    open('General');
    cy.get('#version small').should('have.text', 'Version 9.9.10 is out. Run the line below in Terminal, then quit Filedrawer and open it again.');
    cy.get('#update-cmd').should('have.text', 'brew upgrade filedrawer');
    cy.get('#copy-cmd').click();
    cy.calls('copyText').should('deep.equal', [['brew upgrade filedrawer']]);
    cy.get('#copy-cmd').should('have.text', 'Copied');
  });

  it('the buttons on General call the app', () => {
    cy.page('settings/index.html');
    open('General');
    cy.get('#export').click();
    cy.get('#reset').click();
    cy.get('#ph-btn').should('have.text', 'Allow').click();
    cy.calls('exportSettings').should('have.length', 1);
    cy.calls('resetSettings').should('have.length', 1);
    cy.calls('photosAsk').should('have.length', 1);
  });
});
