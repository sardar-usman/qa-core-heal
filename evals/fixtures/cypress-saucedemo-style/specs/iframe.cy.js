describe('login', () => {
  it('iframe', () => {
    cy.visit('/');
    cy.get('iframe#login').should('exist');
  });
});
