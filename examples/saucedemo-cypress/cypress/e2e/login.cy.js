describe('login', () => {
  it('signs in', () => {
    const user = Cypress.expose('sauceUser');
    const pass = Cypress.expose('saucePass');
    cy.visit('/');
    cy.get('[data-test="usrname"]').type(user);
    cy.get('[data-test="password"]').type(pass);
    cy.get('[data-test="login-button"]').click();
  });
});
