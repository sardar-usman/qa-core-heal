describe('login', () => {
  it('ambiguous match', () => {
    cy.visit('/');
    cy.get('[data-test="user"]').click();
  });
});
